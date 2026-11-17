/*
  Saved race setups (account-only): an event's lanes, elimination points, kiosk theme and weight unit,
  kept under a name so the next event is set up in one tap and only needs its racers.

    - GET    /api/race-setups
    - POST   /api/race-setups
    - PATCH  /api/race-setups/:setupId
    - DELETE /api/race-setups/:setupId
*/
import type { Express } from "express";
import { nanoid } from "nanoid";
import { requireAuth, signedIn, type AuthRequest } from "../auth.js";
import { raceSetupSchema } from "../schemas.js";
import { collections, HttpError, type Db } from "../store/db.js";
import type { SetupDoc } from "../store/types.js";

const MAX_SETUPS = 50;

const setupJson = (s: SetupDoc) => ({
  id: s.id,
  name: s.name,
  pointLimit: s.pointLimit,
  lanes: s.lanes,
  theme: s.theme,
  weightUnit: s.weightUnit === "oz" ? "oz" : "g",
  updatedAt: s.updatedAt,
});

export function registerRaceSetupRoutes(options: { app: Express; db: Db }) {
  const { app, db } = options;

  const listFor = (userId: string) => db.where<SetupDoc>(collections.setups, "userId", userId);
  const owned = async (req: AuthRequest) => {
    const setup = await db.get<SetupDoc>(collections.setups, req.params.setupId as string);
    if (!setup || setup.userId !== signedIn(req).id) throw new HttpError(404, "Race setup not found");
    return setup;
  };

  app.get("/api/race-setups", requireAuth, async (req: AuthRequest, res) => {
    const setups = await listFor(signedIn(req).id);
    setups.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ setups: setups.map(setupJson) });
  });

  app.post("/api/race-setups", requireAuth, async (req: AuthRequest, res) => {
    const parsed = raceSetupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const user = signedIn(req);
    if ((await listFor(user.id)).length >= MAX_SETUPS) throw new HttpError(400, `You can keep up to ${MAX_SETUPS} race setups.`);
    const now = Date.now();
    const setup: SetupDoc = { id: nanoid(), userId: user.id, ...parsed.data, createdAt: now, updatedAt: now };
    await db.set(collections.setups, setup.id, setup);
    return res.status(201).json(setupJson(setup));
  });

  app.patch("/api/race-setups/:setupId", requireAuth, async (req: AuthRequest, res) => {
    const parsed = raceSetupSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const current = await owned(req);
    const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const setup: SetupDoc = { ...current, ...changes, updatedAt: Date.now() };
    await db.set(collections.setups, setup.id, setup);
    return res.json(setupJson(setup));
  });

  app.delete("/api/race-setups/:setupId", requireAuth, async (req: AuthRequest, res) => {
    const setup = await owned(req);
    await db.delete(collections.setups, setup.id);
    return res.status(204).send();
  });
}
