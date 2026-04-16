/*
  Race Patrol routes (account-only).

  Usage:
  - registerPatrolRoutes({ app, prisma }) is called from server.ts
  - Provides CRUD for reusable racer groups:
    - GET    /api/patrols
    - POST   /api/patrols
    - PATCH  /api/patrols/:patrolId
    - DELETE /api/patrols/:patrolId
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import express from "express";
import { createRacePatrolSchema, updateRacePatrolSchema } from "../schemas.js";
import { requireAuth } from "../auth.js";

export function registerPatrolRoutes(options: { app: Express; prisma: PrismaClient }) {
  const { app, prisma } = options;

  app.get("/api/patrols", requireAuth as express.RequestHandler, async (req: any, res) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const patrols = await prisma.racePatrol.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { racers: true },
    });
    return res.json({
      patrols: patrols.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.getTime(),
        racers: p.racers.map((r) => ({
          id: r.id,
          name: r.name,
          groupName: r.groupName ?? null,
          weight: r.weight ?? null,
        })),
      })),
    });
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

    return res.status(201).json({
      id: patrol.id,
      name: patrol.name,
      createdAt: patrol.createdAt.getTime(),
      racers: patrol.racers.map((r) => ({
        id: r.id,
        name: r.name,
        groupName: r.groupName ?? null,
        weight: r.weight ?? null,
      })),
    });
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

    return res.json({
      id: updated.id,
      name: updated.name,
      createdAt: updated.createdAt.getTime(),
      racers: updated.racers.map((r) => ({
        id: r.id,
        name: r.name,
        groupName: r.groupName ?? null,
        weight: r.weight ?? null,
      })),
    });
  });

  app.delete("/api/patrols/:patrolId", requireAuth as express.RequestHandler, async (req: any, res) => {
    const patrolId = req.params.patrolId as string;
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const existing = await prisma.racePatrol.findUnique({ where: { id: patrolId }, select: { id: true, userId: true } });
    if (!existing || existing.userId !== req.user.id) return res.status(404).json({ message: "Race patrol not found" });
    await prisma.racePatrol.delete({ where: { id: patrolId } });
    return res.status(204).send();
  });
}
