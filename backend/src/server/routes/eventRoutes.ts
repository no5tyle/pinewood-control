/*
  Event routes.

  - event create/read/update/delete, claiming a guest event, and guest kiosk links
  - racers: add, remove, drop, import from Race Patrols
  - heats: generate the next one, post a result
  - popular vote: vote, reveal, and the results page
*/
import type { Express } from "express";
import type { Server } from "socket.io";
import { nanoid } from "nanoid";
import { eventFor, signedIn, type AuthRequest } from "../auth.js";
import { kioskAccessTtlMs } from "../config.js";
import { nextAvailableCarNumbers, shuffle } from "../helpers.js";
import { chooseNextHeat } from "../matchmaking.js";
import {
  changeEvent,
  currentHeat,
  loadEvent,
  newEvent,

  rankByVotes,
  serializeEvent,
  settleCompletion,
} from "../eventService.js";
import { addScoutSchema, createEventSchema, importPatrolsSchema, postResultSchema, popularVoteSchema, updateEventSchema } from "../schemas.js";
import { createRateLimiter } from "../rateLimit.js";
import { collections, HttpError, type Db } from "../store/db.js";
import type { EventDoc, GuestLinkDoc, KioskSessionDoc, PatrolDoc, ScoutDoc, VoteDoc } from "../store/types.js";

const GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

// heatCountOffset is used for late entrants: it adjusts the effective “heats run” count without
// polluting laneHistory (which is used to balance lane fairness).
const heatsRun = (scout: ScoutDoc): number => scout.laneHistory.length + Math.max(0, Math.floor(scout.heatCountOffset || 0));

function newScout(fields: Partial<ScoutDoc> & { name: string; carNumber: string }): ScoutDoc {
  return {
    id: nanoid(10),
    groupName: null,
    weight: null,
    points: 0,
    eliminated: false,
    eliminatedAt: null,
    eliminatedHeatId: null,
    dropped: false,
    droppedAt: null,
    sourcePatrolRacerId: null,
    laneHistory: [],
    heatCountOffset: 0,
    ...fields,
  };
}

function refuseOnceRacing(event: EventDoc, doing: string) {
  if (event.setupComplete) throw new HttpError(400, `Cannot ${doing} after setup is complete`);
  if (event.heats.length > 0) throw new HttpError(400, `Cannot ${doing} after heats have been generated`);
}

export function registerEventRoutes(options: { app: Express; db: Db; io: Server }) {
  const { app, db, io } = options;

  const guestKioskRedeemLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 30, keyPrefix: "guest-kiosk-redeem" });

  const votesFor = (eventId: string) => db.where<VoteDoc>(collections.votes, "eventId", eventId);
  const voteCounts = (votes: VoteDoc[]) => {
    const counts = new Map<string, number>();
    votes.forEach((v) => counts.set(v.favoriteScoutId, (counts.get(v.favoriteScoutId) ?? 0) + 1));
    return counts;
  };

  /** Deletes an event and what hangs off it. */
  const deleteEvent = async (eventId: string) => {
    await db.delete(collections.events, eventId);
    const [votes, links] = await Promise.all([votesFor(eventId), db.where<GuestLinkDoc>(collections.guestLinks, "eventId", eventId)]);
    await Promise.all([
      ...votes.map((v) => db.delete(collections.votes, v.id)),
      ...links.map((l) => db.delete(collections.guestLinks, l.id)),
    ]);
  };

  /** The event's owner, or 401/404/403. */
  const ownedEvent = async (req: AuthRequest, eventId: string) => {
    const user = signedIn(req);
    const event = await loadEvent(db, eventId);
    if (event.userId !== user.id) throw new HttpError(403, "Permission denied");
    return event;
  };

  app.post("/api/events", async (req: AuthRequest, res) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { isGuest, ...fields } = parsed.data;
    const event = newEvent(nanoid(), { ...fields, userId: req.user?.id ?? null, isGuest: !req.user || isGuest });
    await db.set(collections.events, event.id, event);
    return res.status(201).json(serializeEvent(event));
  });

  app.post("/api/events/:eventId/claim", async (req: AuthRequest, res) => {
    const user = signedIn(req);
    const updated = await changeEvent(db, io, req.params.eventId as string, (event) => {
      if (event.userId) throw new HttpError(400, "Event already claimed");
      event.userId = user.id;
      event.isGuest = false;
      event.expireAt = null;
    }, { touch: false });
    // The votes are kept with the event now it isn't going to expire
    for (const vote of await votesFor(updated.id)) {
      if (vote.expireAt) await db.set(collections.votes, vote.id, { ...vote, expireAt: null });
    }
    return res.json(serializeEvent(updated));
  });

  app.post("/api/events/:eventId/guest-kiosk-link", async (req: AuthRequest, res) => {
    const event = await ownedEvent(req, req.params.eventId as string);
    const now = Date.now();
    const existing = (await db.where<GuestLinkDoc>(collections.guestLinks, "eventId", event.id))
      .filter((l) => !l.revokedAt && l.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (existing) return res.json({ token: existing.token, expiresAt: existing.expiresAt });

    const link: GuestLinkDoc = {
      id: nanoid(),
      token: nanoid(24),
      eventId: event.id,
      createdAt: now,
      expiresAt: now + GUEST_LINK_TTL_MS,
      revokedAt: null,
      expireAt: new Date(now + GUEST_LINK_TTL_MS),
    };
    await db.set(collections.guestLinks, link.id, link);
    await changeEvent(db, io, event.id, () => undefined);
    return res.status(201).json({ token: link.token, expiresAt: link.expiresAt });
  });

  app.delete("/api/events/:eventId/guest-kiosk-link", async (req: AuthRequest, res) => {
    const event = await ownedEvent(req, req.params.eventId as string);
    const now = Date.now();
    for (const link of await db.where<GuestLinkDoc>(collections.guestLinks, "eventId", event.id)) {
      if (!link.revokedAt) await db.set(collections.guestLinks, link.id, { ...link, revokedAt: now });
    }
    await changeEvent(db, io, event.id, () => undefined);
    return res.status(204).send();
  });

  app.delete("/api/events/:eventId/guest", async (req: AuthRequest, res) => {
    const event = await loadEvent(db, req.params.eventId as string);
    if (!event.isGuest || event.userId) throw new HttpError(403, "Not a guest event");
    await deleteEvent(event.id);
    return res.status(204).send();
  });

  app.get("/api/events/:eventId", async (req: AuthRequest, res) => {
    const event = await eventFor(db, req, req.params.eventId as string, false);
    return res.json(serializeEvent(event));
  });

  app.delete("/api/events/:eventId", async (req: AuthRequest, res) => {
    const event = await ownedEvent(req, req.params.eventId as string);
    await deleteEvent(event.id);
    return res.status(204).send();
  });

  app.get("/api/events", async (req: AuthRequest, res) => {
    if (!req.user) return res.json({ events: [] });
    const events = await db.where<EventDoc>(collections.events, "userId", req.user.id);
    events.sort((a, b) => b.createdAt - a.createdAt);
    return res.json({ events: events.map(serializeEvent) });
  });

  app.patch("/api/events/:eventId", async (req: AuthRequest, res) => {
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    await eventFor(db, req, req.params.eventId as string, true);
    const updated = await changeEvent(db, io, req.params.eventId as string, (event) => {
      Object.assign(event, Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)));
    });
    return res.json(serializeEvent(updated));
  });

  app.post("/api/events/:eventId/scouts", async (req: AuthRequest, res) => {
    const parsed = addScoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    await eventFor(db, req, req.params.eventId as string, true);

    let added: ScoutDoc | null = null;
    await changeEvent(db, io, req.params.eventId as string, (event) => {
      const isLateEntrant = event.setupComplete || event.heats.length > 0;
      const eligible = event.scouts.filter((s) => !s.eliminated);
      const avgRuns =
        isLateEntrant && eligible.length > 0
          ? Math.max(0, Math.round(eligible.reduce((sum, s) => sum + heatsRun(s), 0) / eligible.length))
          : 0;
      const pointsPenalty = parsed.data.pointsPenalty ?? 0;
      const startsEliminated = pointsPenalty >= event.pointLimit;
      const now = Date.now();
      added = newScout({
        name: parsed.data.name,
        carNumber: nextAvailableCarNumbers(event.scouts, 1)[0],
        groupName: parsed.data.groupName ?? null,
        weight: parsed.data.weight ?? null,
        points: pointsPenalty,
        eliminated: startsEliminated,
        eliminatedAt: startsEliminated ? now : null,
        heatCountOffset: avgRuns,
      });
      event.scouts.push(added);
      if (isLateEntrant) {
        event.logs.push({ id: nanoid(), type: "late_entrant", createdAt: now, scoutId: added.id, pointsPenalty });
      }
    });
    return res.status(201).json(added);
  });

  app.post("/api/events/:eventId/scouts/import-patrols", async (req: AuthRequest, res) => {
    const parsed = importPatrolsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const user = signedIn(req);
    refuseOnceRacing(await eventFor(db, req, req.params.eventId as string, true), "import patrols");

    const patrols = await Promise.all(parsed.data.patrolIds.map((id) => db.get<PatrolDoc>(collections.patrols, id)));
    if (patrols.some((p) => !p || p.userId !== user.id)) throw new HttpError(404, "One or more patrols were not found");
    const racers = patrols.flatMap((p) => p!.racers);
    if (racers.length === 0) throw new HttpError(400, "No racers to import");

    let created = 0;
    await changeEvent(db, io, req.params.eventId as string, (event) => {
      refuseOnceRacing(event, "import patrols");
      const already = new Set(event.scouts.map((s) => s.sourcePatrolRacerId).filter(Boolean));
      const missing = racers.filter((r) => !already.has(r.id));
      if (missing.length === 0) throw new HttpError(400, "All selected patrol racers are already in this event");
      const numbers = shuffle(nextAvailableCarNumbers(event.scouts, missing.length));
      missing.forEach((r, i) => {
        event.scouts.push(
          newScout({ name: r.name, carNumber: numbers[i], groupName: r.groupName, weight: r.weight, sourcePatrolRacerId: r.id }),
        );
      });
      created = missing.length;
    });
    return res.status(201).json({ created, skipped: racers.length - created });
  });

  app.delete("/api/events/:eventId/scouts/:scoutId", async (req: AuthRequest, res) => {
    await eventFor(db, req, req.params.eventId as string, true);
    await changeEvent(db, io, req.params.eventId as string, (event) => {
      refuseOnceRacing(event, "delete racers");
      const index = event.scouts.findIndex((s) => s.id === req.params.scoutId);
      if (index < 0) throw new HttpError(404, "Racer not found");
      event.scouts.splice(index, 1);
    });
    return res.status(204).send();
  });

  app.post("/api/events/:eventId/scouts/:scoutId/drop", async (req: AuthRequest, res) => {
    await eventFor(db, req, req.params.eventId as string, true);
    const scoutId = req.params.scoutId as string;
    await changeEvent(db, io, req.params.eventId as string, (event) => {
      if (event.completedAt) throw new HttpError(400, "Event is complete");
      const scout = event.scouts.find((s) => s.id === scoutId);
      if (!scout) throw new HttpError(404, "Racer not found");
      if (scout.eliminated) throw new HttpError(400, "Racer is already out");
      if (event.scouts.filter((s) => !s.eliminated).length <= 1) throw new HttpError(400, "Cannot drop the last remaining racer");
      if (currentHeat(event)?.laneAssignments.includes(scoutId)) {
        throw new HttpError(400, "Cannot drop a racer while they are in the current heat");
      }

      const now = Date.now();
      Object.assign(scout, { eliminated: true, eliminatedAt: now, eliminatedHeatId: null, dropped: true, droppedAt: now });
      event.logs.push({ id: nanoid(), type: "drop", createdAt: now, scoutId, pointsPenalty: null });
      settleCompletion(event);
    });
    return res.status(200).json({ message: "Racer dropped" });
  });

  app.post("/api/events/:eventId/next-heat", async (req: AuthRequest, res) => {
    await eventFor(db, req, req.params.eventId as string, true);
    let heat: EventDoc["heats"][number] | null = null;
    await changeEvent(db, io, req.params.eventId as string, (event) => {
      if (currentHeat(event)) throw new HttpError(400, "Finish the current heat before generating the next heat");
      if (event.scouts.filter((s) => !s.eliminated).length <= 1) throw new HttpError(400, "Tournament is already complete");

      const laneAssignments = chooseNextHeat(event);
      if (!laneAssignments) throw new HttpError(400, "Cannot generate a valid heat with fewer than 2 active racers");
      laneAssignments.forEach((id, i) => event.scouts.find((s) => s.id === id)?.laneHistory.push(i + 1));
      heat = {
        id: nanoid(8),
        laneAssignments,
        finishOrder: [],
        loserScoutIds: [],
        laneTimes: {},
        winnerScoutId: null,
        createdAt: Date.now(),
      };
      event.heats.push(heat);
    });
    return res.status(201).json(heat);
  });

  app.post("/api/events/:eventId/heats/:heatId/result", async (req: AuthRequest, res) => {
    const parsed = postResultSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    await eventFor(db, req, req.params.eventId as string, true);

    await changeEvent(db, io, req.params.eventId as string, (event) => {
      const heat = event.heats.find((h) => h.id === req.params.heatId);
      if (!heat) throw new HttpError(404, "Heat not found");
      if (heat.finishOrder.length > 0) throw new HttpError(400, "Result already posted");

      const finishOrder = parsed.data.finishOrder;
      const laneSet = new Set(heat.laneAssignments);
      if (finishOrder.length !== heat.laneAssignments.length) {
        throw new HttpError(400, "Finish order must include every racer in the heat");
      }
      if (new Set(finishOrder).size !== finishOrder.length) throw new HttpError(400, "Finish order cannot contain duplicates");
      if (finishOrder.some((id) => !laneSet.has(id))) throw new HttpError(400, "Finish order must match the racers in the heat");

      // Timer times, kept only for racers in this heat
      const laneTimes: Record<string, number | null> = {};
      for (const [scoutId, seconds] of Object.entries(parsed.data.laneTimes ?? {})) {
        if (laneSet.has(scoutId)) laneTimes[scoutId] = seconds;
      }
      Object.assign(heat, { finishOrder, winnerScoutId: finishOrder[0], loserScoutIds: finishOrder.slice(1), laneTimes });

      const now = Date.now();
      finishOrder.forEach((scoutId, position) => {
        const scout = event.scouts.find((s) => s.id === scoutId);
        if (!scout) return;
        scout.points += position;
        if (!scout.eliminated && scout.points >= event.pointLimit) {
          scout.eliminatedAt = now;
          scout.eliminatedHeatId = heat.id;
        }
        scout.eliminated = scout.points >= event.pointLimit;
      });
      settleCompletion(event);
    });
    return res.status(200).json({ message: "Result saved" });
  });

  app.get("/api/events/:eventId/popular-vote", async (req: AuthRequest, res) => {
    const event = await eventFor(db, req, req.params.eventId as string, false);
    const votes = await votesFor(event.id);
    const serialized = serializeEvent(event);
    return res.json({
      completedAt: event.completedAt ?? null,
      totalVotes: votes.length,
      revealAt: event.popularVoteRevealAt ?? null,
      revealCountdownSeconds: 3,
      winner: serialized.popularVoteWinner,
      ranks: event.popularVoteRevealAt ? rankByVotes(event.scouts, voteCounts(votes)) : [],
    });
  });

  app.post("/api/events/:eventId/popular-vote", async (req: AuthRequest, res) => {
    const parsed = popularVoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const event = await eventFor(db, req, req.params.eventId as string, true);
    if (event.popularVoteRevealAt) throw new HttpError(400, "Popular vote has been revealed");
    if (!event.scouts.some((s) => s.id === parsed.data.favoriteScoutId)) throw new HttpError(400, "Invalid racer selection");

    const vote: VoteDoc = {
      id: nanoid(),
      eventId: event.id,
      favoriteScoutId: parsed.data.favoriteScoutId,
      createdAt: Date.now(),
      expireAt: event.expireAt,
    };
    await db.set(collections.votes, vote.id, vote);
    return res.status(201).json({ id: vote.id, createdAt: vote.createdAt });
  });

  app.post("/api/events/:eventId/popular-vote/reveal", async (req: AuthRequest, res) => {
    await eventFor(db, req, req.params.eventId as string, true);
    const votes = await votesFor(req.params.eventId as string);
    const counts = voteCounts(votes);
    const updated = await changeEvent(db, io, req.params.eventId as string, (event) => {
      if (!event.completedAt) throw new HttpError(400, "Event is not complete yet");
      if (event.popularVoteRevealAt) throw new HttpError(400, "Popular vote has already been revealed");
      const top = rankByVotes(event.scouts, counts)[0];
      event.popularVoteRevealAt = Date.now();
      event.popularVoteWinnerScoutId = top && top.votes > 0 ? top.scout.id : null;
    }, { touch: false });
    return res.status(200).json({
      revealAt: updated.popularVoteRevealAt,
      revealCountdownSeconds: 3,
      winnerScoutId: updated.popularVoteWinnerScoutId,
      totalVotes: votes.length,
    });
  });

  app.get("/api/events/:eventId/results", async (req: AuthRequest, res) => {
    const event = await eventFor(db, req, req.params.eventId as string, false);
    const serialized = serializeEvent(event);
    const scoutsById = new Map(event.scouts.map((s) => [s.id, s]));
    const votes = await votesFor(event.id);

    return res.json({
      event: serialized,
      completedAt: event.completedAt ?? null,
      champion: serialized.championScoutId ? scoutsById.get(serialized.championScoutId) ?? null : null,
      timeline: event.logs.map((log) => ({
        id: log.id,
        type: log.type,
        createdAt: log.createdAt,
        scoutId: log.scoutId ?? null,
        pointsPenalty: typeof log.pointsPenalty === "number" ? log.pointsPenalty : null,
      })),
      popularVote: {
        totalVotes: votes.length,
        revealAt: event.popularVoteRevealAt ?? null,
        revealCountdownSeconds: 3,
        winner: serialized.popularVoteWinner,
        ranks: event.popularVoteRevealAt ? rankByVotes(event.scouts, voteCounts(votes)) : [],
      },
      heatResults: event.heats.map((heat) => ({
        id: heat.id,
        createdAt: heat.createdAt,
        eliminatedScoutIds: event.scouts.filter((s) => s.eliminatedHeatId === heat.id).map((s) => s.id),
        placements: heat.finishOrder.map((scoutId, index) => ({ place: index + 1, scout: scoutsById.get(scoutId) ?? null })),
        winnerScoutId: heat.winnerScoutId ?? null,
        loserScoutIds: heat.loserScoutIds,
      })),
    });
  });

  app.post("/api/guest-kiosk/:token", guestKioskRedeemLimiter, async (req, res) => {
    const link = (await db.where<GuestLinkDoc>(collections.guestLinks, "token", req.params.token as string))[0];
    if (!link) throw new HttpError(404, "Guest kiosk link not found");
    if (link.revokedAt) throw new HttpError(410, "Guest kiosk link revoked");
    if (Date.now() > link.expiresAt) throw new HttpError(410, "Guest kiosk link expired");

    const expiresAt = Date.now() + kioskAccessTtlMs;
    const session: KioskSessionDoc = {
      token: nanoid(12),
      expiresAt,
      accessExpiresAt: expiresAt,
      eventId: link.eventId,
      guestKioskLinkId: link.id,
      expireAt: new Date(expiresAt),
    };
    await db.set(collections.kioskSessions, session.token, session);
    return res.status(201).json({ token: session.token, eventId: session.eventId, expiresAt });
  });

}
