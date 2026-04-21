/*
  Event routes.

  Usage:
  - registerEventRoutes({ app, prisma, io }) is called from server.ts
  - Contains the core API for:
    - event CRUD + claiming + guest kiosk link
    - racer add/remove/import (Race Patrols)
    - generating heats and submitting results
    - popular vote submission + reveal
    - results export payload (history + popular vote)
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import type { Server } from "socket.io";
import { nanoid } from "nanoid";
import { requireEventReadAccess, requireEventWriteAccess } from "../auth.js";
import { kioskAccessTtlMs } from "../config.js";
import { safeParseJSON, nextAvailableCarNumbers, shuffle } from "../helpers.js";
import { chooseNextHeat } from "../matchmaking.js";
import { publishEvent, serializeEvent, getEventWithDetails, touchEvent } from "../eventService.js";
import { addScoutSchema, createEventSchema, importPatrolsSchema, postResultSchema, popularVoteSchema, updateEventSchema } from "../schemas.js";
import { createRateLimiter } from "../rateLimit.js";

export function registerEventRoutes(options: { app: Express; prisma: PrismaClient; io: Server }) {
  const { app, prisma, io } = options;

  const guestKioskRedeemLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 30, keyPrefix: "guest-kiosk-redeem" });

  app.post("/api/events", async (req: any, res) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const isGuest = !req.user || parsed.data.isGuest;
    const event = await prisma.event.create({
      data: {
        name: parsed.data.name,
        pointLimit: parsed.data.pointLimit,
        lanes: parsed.data.lanes,
        theme: parsed.data.theme,
        weightUnit: parsed.data.weightUnit,
        userId: req.user?.id || null,
        isGuest,
      },
      include: { scouts: true, heats: true },
    });

    return res.status(201).json(serializeEvent(event));
  });

  app.post("/api/events/:eventId/claim", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    try {
      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.userId) return res.status(400).json({ message: "Event already claimed" });

      const updated = await prisma.event.update({
        where: { id: eventId },
        data: { userId: req.user.id, isGuest: false },
      });

      await publishEvent(io, prisma, updated.id);
      return res.json(serializeEvent(updated));
    } catch {
      return res.status(500).json({ message: "Error claiming event" });
    }
  });

  app.post("/api/events/:eventId/guest-kiosk-link", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Event not found" });
    if (event.userId !== req.user.id) return res.status(403).json({ message: "Permission denied" });

    const now = new Date();
    const existing = await (prisma as any).guestKioskLink.findFirst({
      where: { eventId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return res.json({ token: existing.token, expiresAt: existing.expiresAt.getTime() });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const link = await (prisma as any).guestKioskLink.create({
      data: { token: nanoid(24), eventId, expiresAt },
    });
    await touchEvent(prisma, eventId);
    return res.status(201).json({ token: link.token, expiresAt: link.expiresAt.getTime() });
  });

  app.delete("/api/events/:eventId/guest-kiosk-link", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Event not found" });
    if (event.userId !== req.user.id) return res.status(403).json({ message: "Permission denied" });

    await (prisma as any).guestKioskLink.updateMany({
      where: { eventId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await touchEvent(prisma, eventId);
    return res.status(204).send();
  });

  app.delete("/api/events/:eventId/guest", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    try {
      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (!event.isGuest || event.userId) return res.status(403).json({ message: "Not a guest event" });

      await prisma.event.delete({ where: { id: eventId } });
      return res.status(204).send();
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.get("/api/events/:eventId", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    try {
      const event = await getEventWithDetails(prisma, eventId);
      const allowed = await requireEventReadAccess(prisma, req, res, event.id);
      if (!allowed) return;
      return res.json(serializeEvent(event));
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.delete("/api/events/:eventId", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    try {
      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.userId !== req.user.id) return res.status(403).json({ message: "Permission denied" });

      await prisma.event.delete({ where: { id: eventId } });
      return res.status(204).send();
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.get("/api/events", async (req: any, res) => {
    if (!req.user) return res.json({ events: [] });
    const allEvents = await prisma.event.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { scouts: true, heats: true },
    });
    return res.json({ events: allEvents.map((e) => serializeEvent(e)) });
  });

  app.patch("/api/events/:eventId", async (req: any, res) => {
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await prisma.event.update({
        where: { id: req.params.eventId },
        data: parsed.data,
        include: { scouts: true, heats: true },
      });
      await publishEvent(io, prisma, event.id);
      return res.json(serializeEvent(event));
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/scouts", async (req: any, res) => {
    const parsed = addScoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await prisma.event.findUnique({
        where: { id: req.params.eventId },
        select: { id: true, pointLimit: true, setupComplete: true, lanes: true },
      });
      if (!event) return res.status(404).json({ message: "Event not found" });
      const existing = await prisma.scout.findMany({
        where: { eventId: req.params.eventId },
        select: { carNumber: true, laneHistory: true },
      });
      const carNumber = nextAvailableCarNumbers(existing, 1)[0];
      const heatCount = await prisma.heat.count({ where: { eventId: req.params.eventId } });
      const isLateEntrant = event.setupComplete || heatCount > 0;
      const avgRuns = (() => {
        if (!isLateEntrant) return 0;
        if (existing.length === 0) return 0;
        const totalRuns = existing.reduce((sum, s) => sum + safeParseJSON<number[]>(s.laneHistory, []).length, 0);
        return Math.max(0, Math.round(totalRuns / existing.length));
      })();
      const initialLaneHistory =
        isLateEntrant && avgRuns > 0
          ? Array.from({ length: avgRuns }, (_, i) => (i % Math.max(2, event.lanes)) + 1)
          : [];
      const pointsPenalty = parsed.data.pointsPenalty ?? 0;
      const startsEliminated = pointsPenalty >= event.pointLimit;
      const scout = await prisma.scout.create({
        data: {
          id: nanoid(10),
          name: parsed.data.name,
          carNumber,
          groupName: parsed.data.groupName ?? null,
          weight: parsed.data.weight ?? null,
          points: pointsPenalty,
          eliminated: startsEliminated,
          eliminatedAt: startsEliminated ? new Date() : null,
          laneHistory: JSON.stringify(initialLaneHistory),
          eventId: req.params.eventId,
        },
      });

      if (isLateEntrant) {
        await prisma.eventLog.create({
          data: {
            eventId: req.params.eventId,
            type: "late_entrant",
            scoutId: scout.id,
            pointsPenalty,
          },
        });
      }

      await touchEvent(prisma, req.params.eventId);
      await publishEvent(io, prisma, req.params.eventId);
      return res.status(201).json(scout);
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/scouts/import-patrols", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    const parsed = importPatrolsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    try {
      const access = await requireEventWriteAccess(prisma, req, res, eventId);
      if (!access) return;

      const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, setupComplete: true },
      });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.setupComplete) return res.status(400).json({ message: "Cannot import patrols after setup is complete" });
      const heatCount = await prisma.heat.count({ where: { eventId } });
      if (heatCount > 0) return res.status(400).json({ message: "Cannot import patrols after heats have been generated" });

      const patrols = await (prisma as any).racePatrol.findMany({
        where: { id: { in: parsed.data.patrolIds }, userId: req.user.id },
        include: { racers: true },
      });
      if (patrols.length !== parsed.data.patrolIds.length) {
        return res.status(404).json({ message: "One or more patrols were not found" });
      }

      const racers = patrols.flatMap((p: any) => p.racers);
      if (racers.length === 0) return res.status(400).json({ message: "No racers to import" });

      const racersById = new Map<string, any>(racers.map((r: any) => [String(r.id), r]));
      const existingFromPatrol = await prisma.scout.findMany({
        where: { eventId, sourcePatrolRacerId: { in: Array.from(racersById.keys()) } },
        select: { sourcePatrolRacerId: true },
      });
      const alreadyIds = new Set(
        existingFromPatrol
          .map((s) => s.sourcePatrolRacerId)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      );

      const missingRacers = racers.filter((r: any) => !alreadyIds.has(r.id));
      if (missingRacers.length === 0) {
        return res.status(400).json({ message: "All selected patrol racers are already in this event" });
      }

      const existing = await prisma.scout.findMany({
        where: { eventId },
        select: { carNumber: true },
      });
      const nextNumbers = shuffle(nextAvailableCarNumbers(existing, missingRacers.length));

      await prisma.$transaction(
        missingRacers.map((r: any, idx: number) =>
          prisma.scout.create({
            data: {
              id: nanoid(10),
              name: r.name,
              carNumber: nextNumbers[idx],
              groupName: r.groupName ?? null,
              weight: r.weight ?? null,
              points: 0,
              eliminated: false,
              eliminatedAt: null,
              eventId,
              sourcePatrolRacerId: r.id,
            },
          })
        )
      );

      await touchEvent(prisma, eventId);
      await publishEvent(io, prisma, eventId);
      return res.status(201).json({ created: missingRacers.length, skipped: racers.length - missingRacers.length });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.delete("/api/events/:eventId/scouts/:scoutId", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    const scoutId = req.params.scoutId as string;
    try {
      const access = await requireEventWriteAccess(prisma, req, res, eventId);
      if (!access) return;

      const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, setupComplete: true } });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.setupComplete) return res.status(400).json({ message: "Cannot delete racers after setup is complete" });
      const heatCount = await prisma.heat.count({ where: { eventId } });
      if (heatCount > 0) return res.status(400).json({ message: "Cannot delete racers after heats have been generated" });

      const scout = await prisma.scout.findUnique({ where: { id: scoutId }, select: { id: true, eventId: true } });
      if (!scout || scout.eventId !== eventId) return res.status(404).json({ message: "Racer not found" });

      await prisma.scout.delete({ where: { id: scoutId } });
      await touchEvent(prisma, eventId);
      await publishEvent(io, prisma, eventId);
      return res.status(204).send();
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/scouts/:scoutId/drop", async (req: any, res) => {
    const eventId = req.params.eventId as string;
    const scoutId = req.params.scoutId as string;
    try {
      const access = await requireEventWriteAccess(prisma, req, res, eventId);
      if (!access) return;

      const event = await getEventWithDetails(prisma, eventId);
      if (event.completedAt) return res.status(400).json({ message: "Event is complete" });
      const scout = event.scouts.find((s: any) => s.id === scoutId);
      if (!scout) return res.status(404).json({ message: "Racer not found" });
      if (scout.eliminated) return res.status(400).json({ message: "Racer is already out" });

      const activeBeforeDrop = event.scouts.filter((s: any) => !s.eliminated);
      if (activeBeforeDrop.length <= 1) {
        return res.status(400).json({ message: "Cannot drop the last remaining racer" });
      }

      const currentHeat = event.heats.find((h: any) => safeParseJSON<string[]>(h.finishOrder, []).length === 0);
      if (currentHeat) {
        const laneAssignments = safeParseJSON<string[]>(currentHeat.laneAssignments, []);
        if (laneAssignments.includes(scoutId)) {
          return res.status(400).json({ message: "Cannot drop a racer while they are in the current heat" });
        }
      }

      const droppedAt = new Date();
      await prisma.scout.update({
        where: { id: scoutId },
        data: {
          eliminated: true,
          eliminatedAt: droppedAt,
          eliminatedHeatId: null,
          dropped: true,
          droppedAt,
        },
      });

      await prisma.eventLog.create({
        data: {
          eventId,
          type: "drop",
          scoutId,
        },
      });

      const updatedEvent = await getEventWithDetails(prisma, eventId);
      const activeScouts = updatedEvent.scouts.filter((s: any) => !s.eliminated);
      if (activeScouts.length === 1 && !updatedEvent.completedAt) {
        await prisma.event.update({ where: { id: eventId }, data: { completedAt: new Date() } });
      }

      await touchEvent(prisma, eventId);
      await publishEvent(io, prisma, eventId);
      return res.status(200).json({ message: "Racer dropped" });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/next-heat", async (req: any, res) => {
    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await getEventWithDetails(prisma, req.params.eventId);
      const scouts = event.scouts.map((s: any) => ({ ...s, laneHistory: safeParseJSON<number[]>(s.laneHistory, []) }));
      const active = scouts.filter((s: any) => !s.eliminated);
      if (active.length <= 1) return res.status(400).json({ message: "Tournament is already complete" });

      const heat = await chooseNextHeat(prisma, req.params.eventId);
      if (!heat) return res.status(400).json({ message: "Cannot generate a valid heat with fewer than 2 active racers" });

      await touchEvent(prisma, req.params.eventId);
      await publishEvent(io, prisma, req.params.eventId);
      return res.status(201).json({
        ...heat,
        laneAssignments: safeParseJSON<string[]>(heat.laneAssignments, []),
        createdAt: heat.createdAt.getTime(),
      });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/heats/:heatId/result", async (req: any, res) => {
    const parsed = postResultSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await getEventWithDetails(prisma, req.params.eventId);
      const heat = event.heats.find((h: any) => h.id === req.params.heatId);
      if (!heat) return res.status(404).json({ message: "Heat not found" });
      if (safeParseJSON<string[]>(heat.finishOrder, []).length > 0) {
        return res.status(400).json({ message: "Result already posted" });
      }

      const laneAssignments = safeParseJSON<string[]>(heat.laneAssignments, []);
      const finishOrder = parsed.data.finishOrder;

      if (finishOrder.length !== laneAssignments.length) {
        return res.status(400).json({ message: "Finish order must include every racer in the heat" });
      }

      const laneSet = new Set(laneAssignments);
      const finishSet = new Set(finishOrder);
      if (finishSet.size !== finishOrder.length) {
        return res.status(400).json({ message: "Finish order cannot contain duplicates" });
      }
      for (const scoutId of finishOrder) {
        if (!laneSet.has(scoutId)) {
          return res.status(400).json({ message: "Finish order must match the racers in the heat" });
        }
      }

      const winnerScoutId = finishOrder[0];
      const loserScoutIds = finishOrder.slice(1);

      await prisma.heat.update({
        where: { id: req.params.heatId },
        data: {
          finishOrder: JSON.stringify(finishOrder),
          winnerScoutId,
          loserScoutIds: JSON.stringify(loserScoutIds),
        },
      });

      const eliminationMoment = new Date();

      for (let position = 0; position < finishOrder.length; position += 1) {
        const scoutId = finishOrder[position];
        const scout = event.scouts.find((s: any) => s.id === scoutId);
        if (!scout) continue;

        const newPoints = scout.points + position;
        const justEliminated = !scout.eliminated && newPoints >= event.pointLimit;
        await prisma.scout.update({
          where: { id: scoutId },
          data: {
            points: newPoints,
            eliminated: newPoints >= event.pointLimit,
            eliminatedAt: justEliminated ? eliminationMoment : undefined,
            eliminatedHeatId: justEliminated ? heat.id : undefined,
          },
        });
      }

      const updatedEvent = await getEventWithDetails(prisma, req.params.eventId);
      const activeScouts = updatedEvent.scouts.filter((s: any) => !s.eliminated);
      if (activeScouts.length === 1 && !updatedEvent.completedAt) {
        await prisma.event.update({
          where: { id: req.params.eventId },
          data: { completedAt: new Date() },
        });
      }

      await touchEvent(prisma, req.params.eventId);
      await publishEvent(io, prisma, req.params.eventId);
      return res.status(200).json({ message: "Result saved" });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.get("/api/events/:eventId/popular-vote", async (req: any, res) => {
    try {
      const access = await requireEventReadAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await getEventWithDetails(prisma, req.params.eventId);
      const serialized = serializeEvent(event);
      const votes = await prisma.popularVote.findMany({
        where: { eventId: req.params.eventId },
        select: { favoriteScoutId: true, createdAt: true },
      });

      const votesByFavorite = new Map<string, number>();
      votes.forEach((v) => votesByFavorite.set(v.favoriteScoutId, (votesByFavorite.get(v.favoriteScoutId) ?? 0) + 1));

      const ranks =
        event.popularVoteRevealAt
          ? [...serialized.scouts]
              .map((s: any) => ({
                scout: s,
                votes: votesByFavorite.get(s.id) ?? 0,
              }))
              .sort((a, b) => {
                if (a.votes !== b.votes) return b.votes - a.votes;
                const aNum = Number.parseInt(String(a.scout.carNumber ?? ""), 10);
                const bNum = Number.parseInt(String(b.scout.carNumber ?? ""), 10);
                if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
                return String(a.scout.name ?? "").localeCompare(String(b.scout.name ?? ""));
              })
          : [];

      const winner = event.popularVoteWinnerScoutId
        ? serialized.scouts.find((s: any) => s.id === event.popularVoteWinnerScoutId) ?? null
        : null;

      return res.json({
        completedAt: event.completedAt?.getTime() ?? null,
        totalVotes: votes.length,
        revealAt: event.popularVoteRevealAt?.getTime() ?? null,
        revealCountdownSeconds: event.popularVoteRevealCountdownSeconds ?? 10,
        winner,
        ranks,
      });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/popular-vote", async (req: any, res) => {
    const parsed = popularVoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await prisma.event.findUnique({
        where: { id: req.params.eventId },
        select: { id: true, completedAt: true, popularVoteRevealAt: true },
      });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.popularVoteRevealAt) return res.status(400).json({ message: "Popular vote has been revealed" });

      const favorite = await prisma.scout.findFirst({
        where: { eventId: req.params.eventId, id: parsed.data.favoriteScoutId },
        select: { id: true },
      });
      if (!favorite) return res.status(400).json({ message: "Invalid racer selection" });

      const vote = await prisma.popularVote.create({
        data: {
          eventId: req.params.eventId,
          favoriteScoutId: parsed.data.favoriteScoutId,
        },
      });

      await touchEvent(prisma, req.params.eventId);
      return res.status(201).json({ id: vote.id, createdAt: vote.createdAt.getTime() });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/events/:eventId/popular-vote/reveal", async (req: any, res) => {
    try {
      const access = await requireEventWriteAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await prisma.event.findUnique({
        where: { id: req.params.eventId },
        select: { id: true, completedAt: true, popularVoteRevealAt: true, popularVoteRevealCountdownSeconds: true },
      });
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (!event.completedAt) return res.status(400).json({ message: "Event is not complete yet" });
      if (event.popularVoteRevealAt) return res.status(400).json({ message: "Popular vote has already been revealed" });

      const scouts = await prisma.scout.findMany({
        where: { eventId: req.params.eventId },
        select: { id: true, carNumber: true, name: true },
      });
      const votes = await prisma.popularVote.findMany({
        where: { eventId: req.params.eventId },
        select: { favoriteScoutId: true },
      });
      const counts = new Map<string, number>();
      votes.forEach((v) => counts.set(v.favoriteScoutId, (counts.get(v.favoriteScoutId) ?? 0) + 1));

      const ranked = [...scouts]
        .map((s) => ({ ...s, votes: counts.get(s.id) ?? 0 }))
        .sort((a, b) => {
          if (a.votes !== b.votes) return b.votes - a.votes;
          const aNum = Number.parseInt(String(a.carNumber ?? ""), 10);
          const bNum = Number.parseInt(String(b.carNumber ?? ""), 10);
          if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
          return String(a.name ?? "").localeCompare(String(b.name ?? ""));
        });

      const winnerId = ranked.length > 0 && ranked[0].votes > 0 ? ranked[0].id : null;
      const revealAt = new Date();
      await prisma.event.update({
        where: { id: req.params.eventId },
        data: {
          popularVoteRevealAt: revealAt,
          popularVoteWinnerScoutId: winnerId,
        },
      });

      await publishEvent(io, prisma, req.params.eventId);
      return res.status(200).json({
        revealAt: revealAt.getTime(),
        revealCountdownSeconds: event.popularVoteRevealCountdownSeconds ?? 10,
        winnerScoutId: winnerId,
        totalVotes: votes.length,
      });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.get("/api/events/:eventId/results", async (req: any, res) => {
    try {
      const access = await requireEventReadAccess(prisma, req, res, req.params.eventId);
      if (!access) return;
      const event = await getEventWithDetails(prisma, req.params.eventId);
      const serialized = serializeEvent(event);
      const serializedScoutsById = new Map(serialized.scouts.map((s: any) => [s.id, s]));
      const votes = await prisma.popularVote.findMany({
        where: { eventId: req.params.eventId },
        select: { favoriteScoutId: true },
      });
      const voteCounts = new Map<string, number>();
      votes.forEach((v) => voteCounts.set(v.favoriteScoutId, (voteCounts.get(v.favoriteScoutId) ?? 0) + 1));
      const popularVoteRanks =
        event.popularVoteRevealAt
          ? [...serialized.scouts]
              .map((s: any) => ({ scout: s, votes: voteCounts.get(s.id) ?? 0 }))
              .sort((a, b) => {
                if (a.votes !== b.votes) return b.votes - a.votes;
                const aNum = Number.parseInt(String(a.scout.carNumber ?? ""), 10);
                const bNum = Number.parseInt(String(b.scout.carNumber ?? ""), 10);
                if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
                return String(a.scout.name ?? "").localeCompare(String(b.scout.name ?? ""));
              })
          : [];
      const popularVoteWinner = serialized.popularVoteWinner ?? null;
      const timeline = (event.logs ?? []).map((log: any) => ({
        id: log.id,
        type: String(log.type),
        createdAt: log.createdAt.getTime(),
        scoutId: log.scoutId ?? null,
        pointsPenalty: typeof log.pointsPenalty === "number" ? log.pointsPenalty : null,
      }));

      return res.json({
        event: serialized,
        completedAt: event.completedAt?.getTime() ?? null,
        champion: serialized.championScoutId ? serializedScoutsById.get(serialized.championScoutId) ?? null : null,
        timeline,
        popularVote: {
          totalVotes: votes.length,
          revealAt: event.popularVoteRevealAt?.getTime() ?? null,
          revealCountdownSeconds: event.popularVoteRevealCountdownSeconds ?? 10,
          winner: popularVoteWinner,
          ranks: popularVoteRanks,
        },
        heatResults: event.heats.map((heat: any) => ({
          id: heat.id,
          createdAt: heat.createdAt.getTime(),
          eliminatedScoutIds: serialized.scouts
            .filter((s: any) => s.eliminatedHeatId === heat.id)
            .map((s: any) => s.id),
          placements: safeParseJSON<string[]>(heat.finishOrder, []).map((scoutId, index) => ({
            place: index + 1,
            scout: serializedScoutsById.get(scoutId) ?? null,
          })),
          winnerScoutId: heat.winnerScoutId ?? null,
          loserScoutIds: safeParseJSON<string[]>(heat.loserScoutIds, []),
        })),
      });
    } catch {
      return res.status(404).json({ message: "Event not found" });
    }
  });

  app.post("/api/guest-kiosk/:token", guestKioskRedeemLimiter, async (req: any, res) => {
    const token = req.params.token as string;
    const now = new Date();
    const link = await (prisma as any).guestKioskLink.findUnique({
      where: { token },
      select: { id: true, eventId: true, expiresAt: true, revokedAt: true },
    });
    if (!link) return res.status(404).json({ message: "Guest kiosk link not found" });
    if (link.revokedAt) return res.status(410).json({ message: "Guest kiosk link revoked" });
    if (now.getTime() > link.expiresAt.getTime()) return res.status(410).json({ message: "Guest kiosk link expired" });

    const sessionToken = nanoid(12);
    const expiresAt = new Date(Date.now() + kioskAccessTtlMs);
    const session = await prisma.kioskSession.create({
      data: {
        token: sessionToken,
        expiresAt,
        accessExpiresAt: expiresAt,
        eventId: link.eventId,
        guestKioskLinkId: link.id,
      } as any,
    });

    return res.status(201).json({
      token: session.token,
      eventId: session.eventId,
      expiresAt: session.expiresAt.getTime(),
    });
  });
}
