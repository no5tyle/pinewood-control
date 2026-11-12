/*
  Saved race setups (account-only): an event's lanes, elimination points, kiosk theme and weight unit,
  kept under a name so the next event is set up in one tap and only needs its racers.

    - GET    /api/race-setups
    - POST   /api/race-setups
    - PATCH  /api/race-setups/:setupId
    - DELETE /api/race-setups/:setupId
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import express from "express";
import { requireAuth } from "../auth.js";
import { raceSetupSchema } from "../schemas.js";

type SetupRow = { id: string; name: string; pointLimit: number; lanes: number; theme: string; weightUnit: string; updatedAt: Date };

const setupJson = (s: SetupRow) => ({
  id: s.id,
  name: s.name,
  pointLimit: s.pointLimit,
  lanes: s.lanes,
  theme: s.theme,
  weightUnit: s.weightUnit === "oz" ? "oz" : "g",
  updatedAt: s.updatedAt.getTime(),
});

export function registerRaceSetupRoutes(options: { app: Express; prisma: PrismaClient }) {
  const { app, prisma } = options;

  const owned = async (userId: string, setupId: string) => {
    const setup = await prisma.raceSetup.findUnique({ where: { id: setupId }, select: { userId: true } });
    return setup?.userId === userId;
  };

  app.get("/api/race-setups", requireAuth as express.RequestHandler, async (req: any, res) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const setups = await prisma.raceSetup.findMany({ where: { userId: req.user.id }, orderBy: { name: "asc" } });
    return res.json({ setups: setups.map(setupJson) });
  });

  app.post("/api/race-setups", requireAuth as express.RequestHandler, async (req: any, res) => {
    const parsed = raceSetupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const count = await prisma.raceSetup.count({ where: { userId: req.user.id } });
    if (count >= 50) return res.status(400).json({ message: "You can keep up to 50 race setups." });
    const setup = await prisma.raceSetup.create({ data: { ...parsed.data, userId: req.user.id } });
    return res.status(201).json(setupJson(setup));
  });

  app.patch("/api/race-setups/:setupId", requireAuth as express.RequestHandler, async (req: any, res) => {
    const parsed = raceSetupSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (!(await owned(req.user.id, req.params.setupId))) return res.status(404).json({ message: "Race setup not found" });
    const setup = await prisma.raceSetup.update({ where: { id: req.params.setupId }, data: parsed.data });
    return res.json(setupJson(setup));
  });

  app.delete("/api/race-setups/:setupId", requireAuth as express.RequestHandler, async (req: any, res) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (!(await owned(req.user.id, req.params.setupId))) return res.status(404).json({ message: "Race setup not found" });
    await prisma.raceSetup.delete({ where: { id: req.params.setupId } });
    return res.status(204).send();
  });
}
