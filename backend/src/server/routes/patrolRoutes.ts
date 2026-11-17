/*
  Race Patrol routes (account-only): reusable groups of racers.

    - GET    /api/patrols
    - POST   /api/patrols
    - PATCH  /api/patrols/:patrolId
    - DELETE /api/patrols/:patrolId
    - POST   /api/patrols/import  (a CSV or Terrain import, or a Terrain resync, saved as a whole)
*/
import type { Express } from "express";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { requireAuth, signedIn, type AuthRequest } from "../auth.js";
import { createRacePatrolSchema, racePatrolRacerSchema, savePatrolSetSchema, updateRacePatrolSchema } from "../schemas.js";
import { collections, HttpError, type Db } from "../store/db.js";
import type { PatrolDoc, PatrolRacerDoc } from "../store/types.js";

/** A Race Patrol as the app sees it, with where its racers came from */
function patrolJson(p: PatrolDoc) {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    source: p.source ?? null,
    terrain: p.source === "terrain" ? p.terrain : null,
    syncedAt: p.syncedAt ?? null,
    racers: p.racers,
  };
}

const newRacer = (r: z.infer<typeof racePatrolRacerSchema>): PatrolRacerDoc => ({
  id: nanoid(),
  name: r.name,
  groupName: r.groupName ?? null,
  weight: r.weight ?? null,
});

export function registerPatrolRoutes(options: { app: Express; db: Db }) {
  const { app, db } = options;

  const listFor = async (userId: string) => {
    const patrols = await db.where<PatrolDoc>(collections.patrols, "userId", userId);
    return patrols.sort((a, b) => b.createdAt - a.createdAt).map(patrolJson);
  };
  const owned = async (req: AuthRequest) => {
    const patrol = await db.get<PatrolDoc>(collections.patrols, req.params.patrolId as string);
    if (!patrol || patrol.userId !== signedIn(req).id) throw new HttpError(404, "Race patrol not found");
    return patrol;
  };

  app.get("/api/patrols", requireAuth, async (req: AuthRequest, res) => {
    return res.json({ patrols: await listFor(signedIn(req).id) });
  });

  app.post("/api/patrols", requireAuth, async (req: AuthRequest, res) => {
    const parsed = createRacePatrolSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const now = Date.now();
    const patrol: PatrolDoc = {
      id: nanoid(),
      userId: signedIn(req).id,
      name: parsed.data.name,
      source: null,
      terrain: null,
      syncedAt: null,
      createdAt: now,
      updatedAt: now,
      racers: parsed.data.racers.map(newRacer),
    };
    await db.set(collections.patrols, patrol.id, patrol);
    return res.status(201).json(patrolJson(patrol));
  });

  app.patch("/api/patrols/:patrolId", requireAuth, async (req: AuthRequest, res) => {
    const parsed = updateRacePatrolSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const current = await owned(req);
    const patrol: PatrolDoc = {
      ...current,
      name: parsed.data.name ?? current.name,
      racers: parsed.data.racers ? parsed.data.racers.map(newRacer) : current.racers,
      updatedAt: Date.now(),
    };
    await db.set(collections.patrols, patrol.id, patrol);
    return res.json(patrolJson(patrol));
  });

  app.delete("/api/patrols/:patrolId", requireAuth, async (req: AuthRequest, res) => {
    const patrol = await owned(req);
    await db.delete(collections.patrols, patrol.id);
    return res.status(204).send();
  });

  /*
    Saves a whole set of patrols at once: optionally deleting every existing patrol first (a CSV upload
    that replaces them all), then making or updating each one. An updated patrol keeps the racers that
    are still in it (matched by name), with their weight and their link to events they raced in, rather
    than replacing them all. Everything is checked before anything is written.
  */
  app.post("/api/patrols/import", requireAuth, async (req: AuthRequest, res) => {
    const parsed = savePatrolSetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const userId = signedIn(req).id;
    const { replaceAll, patrols } = parsed.data;

    const existing = await db.where<PatrolDoc>(collections.patrols, "userId", userId);
    const byId = new Map(existing.map((p) => [p.id, p]));
    if (patrols.some((p) => p.existingId && (replaceAll || !byId.has(p.existingId)))) {
      throw new HttpError(404, "Race patrol not found");
    }

    const now = Date.now();
    const writes: PatrolDoc[] = patrols.map((patrol) => {
      const link = patrol.terrain;
      const meta = {
        name: patrol.name,
        source: patrol.source ?? null,
        terrain: link
          ? {
              unitId: link.unitId,
              unitName: link.unitName,
              scope: link.scope,
              patrol: link.scope === "patrol" ? (link.patrol ?? null) : null,
              includeLeaders: link.includeLeaders ?? false,
            }
          : null,
        syncedAt: patrol.source === "terrain" ? now : null,
        updatedAt: now,
      };
      const current = patrol.existingId ? byId.get(patrol.existingId) : undefined;
      if (!current) return { id: nanoid(), userId, createdAt: now, ...meta, racers: patrol.racers.map(newRacer) };

      const byName = new Map(current.racers.map((r) => [r.name.trim().toLowerCase(), r]));
      const kept = new Set<string>();
      const racers = patrol.racers.map((r) => {
        const match = byName.get(r.name.trim().toLowerCase());
        if (!match || kept.has(match.id)) return newRacer(r);
        kept.add(match.id);
        return { id: match.id, name: r.name, groupName: r.groupName ?? null, weight: r.weight ?? match.weight ?? null };
      });
      return { ...current, ...meta, racers };
    });

    const deleted = replaceAll ? existing.length : 0;
    if (replaceAll) await Promise.all(existing.map((p) => db.delete(collections.patrols, p.id)));
    await Promise.all(writes.map((p) => db.set(collections.patrols, p.id, p)));

    const created = patrols.filter((p) => !p.existingId).length;
    return res.json({ created, updated: patrols.length - created, deleted, patrols: await listFor(userId) });
  });
}
