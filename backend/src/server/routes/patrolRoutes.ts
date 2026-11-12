/*
  Race Patrol routes (account-only).

  Usage:
  - registerPatrolRoutes({ app, prisma }) is called from server.ts
  - Provides CRUD for reusable racer groups:
    - GET    /api/patrols
    - POST   /api/patrols
    - PATCH  /api/patrols/:patrolId
    - DELETE /api/patrols/:patrolId
    - POST   /api/patrols/import  (a CSV or Terrain import, or a Terrain resync, in one transaction)
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import express from "express";
import { createRacePatrolSchema, savePatrolSetSchema, updateRacePatrolSchema } from "../schemas.js";
import { requireAuth } from "../auth.js";

type PatrolRow = {
  id: string;
  name: string;
  createdAt: Date;
  source: string | null;
  terrainUnitId: string | null;
  terrainUnitName: string | null;
  terrainScope: string | null;
  terrainPatrol: string | null;
  terrainLeaders: boolean;
  syncedAt: Date | null;
  racers: { id: string; name: string; groupName: string | null; weight: number | null }[];
};

/** A Race Patrol as the app sees it, with where its racers came from */
function patrolJson(p: PatrolRow) {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.getTime(),
    source: p.source ?? null,
    terrain:
      p.source === "terrain" && p.terrainUnitId && p.terrainScope
        ? {
            unitId: p.terrainUnitId,
            unitName: p.terrainUnitName ?? "",
            scope: p.terrainScope,
            patrol: p.terrainPatrol ?? null,
            includeLeaders: p.terrainLeaders,
          }
        : null,
    syncedAt: p.syncedAt ? p.syncedAt.getTime() : null,
    racers: p.racers.map((r) => ({ id: r.id, name: r.name, groupName: r.groupName ?? null, weight: r.weight ?? null })),
  };
}

export function registerPatrolRoutes(options: { app: Express; prisma: PrismaClient }) {
  const { app, prisma } = options;

  const listFor = async (userId: string) =>
    (await prisma.racePatrol.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: { racers: true } })).map(
      patrolJson,
    );

  app.get("/api/patrols", requireAuth as express.RequestHandler, async (req: any, res) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    return res.json({ patrols: await listFor(req.user.id) });
  });

  app.post("/api/patrols", requireAuth as express.RequestHandler, async (req: any, res) => {
    const parsed = createRacePatrolSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    const patrol = await prisma.racePatrol.create({
      data: {
        name: parsed.data.name,
        userId: req.user.id,
        racers: {
          create: parsed.data.racers.map((r) => ({
            name: r.name,
            groupName: r.groupName ?? null,
            weight: r.weight ?? null,
          })),
        },
      },
      include: { racers: true },
    });

    return res.status(201).json(patrolJson(patrol));
  });

  app.patch("/api/patrols/:patrolId", requireAuth as express.RequestHandler, async (req: any, res) => {
    const patrolId = req.params.patrolId as string;
    const parsed = updateRacePatrolSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    const existing = await prisma.racePatrol.findUnique({ where: { id: patrolId }, select: { id: true, userId: true } });
    if (!existing || existing.userId !== req.user.id) return res.status(404).json({ message: "Race patrol not found" });

    const updated = await prisma.$transaction(async (tx) => {
      if (parsed.data.racers) {
        await tx.racePatrolRacer.deleteMany({ where: { patrolId } });
      }
      return tx.racePatrol.update({
        where: { id: patrolId },
        data: {
          name: parsed.data.name,
          racers: parsed.data.racers
            ? {
                create: parsed.data.racers.map((r) => ({
                  name: r.name,
                  groupName: r.groupName ?? null,
                  weight: r.weight ?? null,
                })),
              }
            : undefined,
        },
        include: { racers: true },
      });
    });

    return res.json(patrolJson(updated));
  });

  app.delete("/api/patrols/:patrolId", requireAuth as express.RequestHandler, async (req: any, res) => {
    const patrolId = req.params.patrolId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const existing = await prisma.racePatrol.findUnique({ where: { id: patrolId }, select: { id: true, userId: true } });
    if (!existing || existing.userId !== req.user.id) return res.status(404).json({ message: "Race patrol not found" });
    await prisma.racePatrol.delete({ where: { id: patrolId } });
    return res.status(204).send();
  });

  /*
    Saves a whole set of patrols at once, so an import can't be left half done: optionally deleting every
    existing patrol first (a CSV upload that replaces them all), then making or updating each one. An
    updated patrol keeps the racers that are still in it, with their weight and their link to events they
    raced in, rather than replacing them all.
  */
  app.post("/api/patrols/import", requireAuth as express.RequestHandler, async (req: any, res) => {
    const parsed = savePatrolSetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const userId = req.user.id as string;
    const { replaceAll, patrols } = parsed.data;

    const owned = await prisma.racePatrol.findMany({ where: { userId }, select: { id: true } });
    const ownedIds = new Set(owned.map((p) => p.id));
    if (patrols.some((p) => p.existingId && (replaceAll || !ownedIds.has(p.existingId)))) {
      return res.status(404).json({ message: "Race patrol not found" });
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const deleted = replaceAll ? (await tx.racePatrol.deleteMany({ where: { userId } })).count : 0;
      let created = 0;
      let updated = 0;
      for (const patrol of patrols) {
        const link = patrol.terrain;
        const meta = {
          name: patrol.name,
          source: patrol.source ?? null,
          terrainUnitId: link?.unitId ?? null,
          terrainUnitName: link?.unitName ?? null,
          terrainScope: link?.scope ?? null,
          terrainPatrol: link?.scope === "patrol" ? (link.patrol ?? null) : null,
          terrainLeaders: link?.includeLeaders ?? false,
          syncedAt: patrol.source === "terrain" ? now : null,
        };
        if (!patrol.existingId) {
          await tx.racePatrol.create({
            data: {
              ...meta,
              userId,
              racers: {
                create: patrol.racers.map((r) => ({ name: r.name, groupName: r.groupName ?? null, weight: r.weight ?? null })),
              },
            },
          });
          created++;
          continue;
        }
        const current = await tx.racePatrolRacer.findMany({ where: { patrolId: patrol.existingId } });
        const byName = new Map(current.map((r) => [r.name.trim().toLowerCase(), r]));
        const keep = new Set<string>();
        for (const r of patrol.racers) {
          const match = byName.get(r.name.trim().toLowerCase());
          if (match && !keep.has(match.id)) {
            keep.add(match.id);
            await tx.racePatrolRacer.update({
              where: { id: match.id },
              data: { name: r.name, groupName: r.groupName ?? null, weight: r.weight ?? match.weight ?? null },
            });
          } else {
            const made = await tx.racePatrolRacer.create({
              data: { patrolId: patrol.existingId, name: r.name, groupName: r.groupName ?? null, weight: r.weight ?? null },
            });
            keep.add(made.id);
          }
        }
        await tx.racePatrolRacer.deleteMany({ where: { patrolId: patrol.existingId, id: { notIn: [...keep] } } });
        await tx.racePatrol.update({ where: { id: patrol.existingId }, data: meta });
        updated++;
      }
      return { created, updated, deleted };
    });

    return res.json({ ...result, patrols: await listFor(userId) });
  });
}
