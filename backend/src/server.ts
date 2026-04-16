import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cors from "cors";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import { nanoid } from "nanoid";
import { Server } from "socket.io";
import { z } from "zod";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key"; 

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);

const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim();
const corsOrigins = corsOrigin.length > 0
  ? corsOrigin
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : [];
const allowAllOrigins = corsOrigins.length === 0;
const allowedOriginSet = new Set(corsOrigins);

const io = new Server(httpServer, {
  cors: allowAllOrigins
    ? { origin: "*" }
    : {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          const normalized = origin.replace(/\/+$/, "");
          return callback(null, allowedOriginSet.has(normalized));
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Kiosk-Token"],
      },
});

// --- Auth Middleware ---

interface AuthRequest extends Request {
  user?: { id: string; email: string };
}

const kioskAccessTtlMs = 3 * 60 * 60_000;

const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(); // Continue as guest if no token
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    req.user = payload;
    next();
  } catch {
    next(); // Invalid token, still treat as guest
  }
};

const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
};

app.use(
  cors(
    allowAllOrigins
      ? undefined
      : {
          origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            const normalized = origin.replace(/\/+$/, "");
            return callback(null, allowedOriginSet.has(normalized));
          },
          credentials: true,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization", "X-Kiosk-Token"],
        }
  )
);
app.use(express.json());
app.use(authenticate as express.RequestHandler);

const guestEventTtlMs = 24 * 60 * 60_000;

async function purgeExpiredGuestEvents() {
  const cutoff = new Date(Date.now() - guestEventTtlMs);
  await prisma.event.deleteMany({
    where: {
      isGuest: true,
      userId: null,
      createdAt: { lt: cutoff },
    },
  });
}

void purgeExpiredGuestEvents().catch(() => undefined);
setInterval(() => {
  void purgeExpiredGuestEvents().catch(() => undefined);
}, 15 * 60_000);

async function canReadEvent(req: AuthRequest, event: { id: string; isGuest: boolean; userId: string | null }): Promise<boolean> {
  if (event.isGuest && !event.userId) return true;
  if (req.user && event.userId && req.user.id === event.userId) return true;

  const kioskToken = req.header("x-kiosk-token");
  if (!kioskToken) return false;

  const session = (await prisma.kioskSession.findUnique({
    where: { token: kioskToken },
  })) as any;
  if (!session) return false;
  if (Date.now() > session.expiresAt.getTime()) return false;
  if (session.eventId !== event.id) return false;

  if (event.userId) {
    if (!session.accessExpiresAt) return false;
    if (Date.now() > session.accessExpiresAt.getTime()) return false;

    if (session.guestKioskLinkId) {
      const link = (await (prisma as any).guestKioskLink.findUnique({
        where: { id: session.guestKioskLinkId },
        select: { revokedAt: true, expiresAt: true },
      })) as { revokedAt: Date | null; expiresAt: Date } | null;
      if (!link) return false;
      if (link.revokedAt) return false;
      if (Date.now() > link.expiresAt.getTime()) return false;
    }
  }

  return true;
}

async function canWriteEvent(req: AuthRequest, event: { id: string; isGuest: boolean; userId: string | null }): Promise<boolean> {
  if (event.isGuest && !event.userId) return true;
  if (req.user && event.userId && req.user.id === event.userId) return true;

  const kioskToken = req.header("x-kiosk-token");
  if (!kioskToken) return false;

  const session = (await prisma.kioskSession.findUnique({
    where: { token: kioskToken },
  })) as any;
  if (!session) return false;
  if (Date.now() > session.expiresAt.getTime()) return false;
  if (session.eventId !== event.id) return false;
  if (session.guestKioskLinkId) return false;

  if (event.userId) {
    if (!session.accessExpiresAt) return false;
    if (Date.now() > session.accessExpiresAt.getTime()) return false;
  }

  return true;
}

async function requireEventReadAccess(req: AuthRequest, res: Response, eventId: string): Promise<{ id: string; isGuest: boolean; userId: string | null } | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, isGuest: true, userId: true },
  });
  if (!event) {
    res.status(404).json({ message: "Event not found" });
    return null;
  }
  const allowed = await canReadEvent(req, event);
  if (!allowed) {
    res.status(403).json({ message: "Authentication required to access this event" });
    return null;
  }
  return event;
}

async function requireEventWriteAccess(req: AuthRequest, res: Response, eventId: string): Promise<{ id: string; isGuest: boolean; userId: string | null } | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, isGuest: true, userId: true },
  });
  if (!event) {
    res.status(404).json({ message: "Event not found" });
    return null;
  }
  const allowed = await canWriteEvent(req, event);
  if (!allowed) {
    res.status(403).json({ message: "Authentication required to access this event" });
    return null;
  }
  return event;
}

// --- Schemas ---

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const createEventSchema = z.object({
  name: z.string().min(2),
  pointLimit: z.number().int().min(1).max(200).default(10),
  lanes: z.number().int().min(2).max(6).default(2),
  isGuest: z.boolean().default(false),
  theme: z.string().default("system"),
});

const updateEventSchema = z.object({
  name: z.string().min(2).optional(),
  pointLimit: z.number().int().min(1).max(200).optional(),
  lanes: z.number().int().min(2).max(6).optional(),
  setupComplete: z.boolean().optional(),
  theme: z.string().optional(),
});

const addScoutSchema = z.object({
  name: z.string().min(1),
  carNumber: z.string().min(1),
});

const postResultSchema = z.object({
  finishOrder: z.array(z.string().min(1)).min(2),
});

// --- Helpers ---

function safeParseJSON<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

async function getEventWithDetails(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      scouts: {
        include: { wonHeats: true }
      },
      heats: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
  if (!event) throw new Error("Event not found");
  return event;
}

function sortStandings(scouts: any[]): any[] {
  return [...scouts].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    if (a.points !== b.points) return a.points - b.points;
    return a.name.localeCompare(b.name);
  });
}

function serializeEvent(event: any) {
  const scouts = event.scouts.map((s: any) => ({
    ...s,
    laneHistory: safeParseJSON<number[]>(s.laneHistory, [])
  }));
  
  const active = scouts.filter((s: any) => !s.eliminated);
  const finalWinner = (event.setupComplete && active.length === 1) ? active[0] : null;
  const currentHeat = event.heats.find((h: any) => safeParseJSON<string[]>(h.finishOrder, []).length === 0);

  return {
    id: event.id,
    name: event.name,
    pointLimit: event.pointLimit,
    lanes: event.lanes,
    setupComplete: event.setupComplete,
    isGuest: Boolean(event.isGuest),
    theme: event.theme,
    createdAt: event.createdAt.getTime(),
    completedAt: event.completedAt?.getTime() ?? null,
    scouts,
    heats: event.heats.map((h: any) => ({
      ...h,
      laneAssignments: safeParseJSON<string[]>(h.laneAssignments, []),
      finishOrder: safeParseJSON<string[]>(h.finishOrder, []),
      loserScoutIds: safeParseJSON<string[]>(h.loserScoutIds, []),
      createdAt: h.createdAt.getTime()
    })),
    standings: sortStandings(scouts),
    currentHeatId: currentHeat?.id ?? null,
    championScoutId: finalWinner?.id ?? null,
    isComplete: Boolean(finalWinner),
  };
}

async function publishEvent(eventId: string) {
  const event = await getEventWithDetails(eventId);
  io.to(eventId).emit("event:update", serializeEvent(event));
}

// --- Heat Generation Logic ---

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function buildPairCounts(eventId: string): Promise<Map<string, number>> {
  const heats = await prisma.heat.findMany({
    where: { eventId },
    select: { laneAssignments: true },
  });

  const counts = new Map<string, number>();
  for (const heat of heats) {
    const laneAssignments = safeParseJSON<string[]>(heat.laneAssignments, []);
    for (let i = 0; i < laneAssignments.length; i += 1) {
      for (let j = i + 1; j < laneAssignments.length; j += 1) {
        const key = pairKey(laneAssignments[i], laneAssignments[j]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function getPermutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of getPermutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

function buildCandidateGroups(active: any[], heatSize: number): any[][] {
  if (active.length < heatSize) return [];
  if (active.length === heatSize) return [active];

  const sorted = [...active].sort((a, b) => {
    if (a.points !== b.points) return a.points - b.points;
    return a.name.localeCompare(b.name);
  });

  const groups: any[][] = [];
  const seen = new Set<string>();

  for (let start = 0; start <= sorted.length - heatSize; start += 1) {
    const window = sorted.slice(start, start + heatSize);
    const key = window.map((s) => s.id).sort().join(",");
    if (!seen.has(key)) {
      seen.add(key);
      groups.push(window);
    }
  }

  return groups;
}

function laneBalanceScore(scout: any, lane: number): number {
  const history = safeParseJSON<number[]>(scout.laneHistory, []);
  return history.filter((l) => l === lane).length;
}

async function chooseNextHeat(eventId: string): Promise<any | null> {
  const event = await getEventWithDetails(eventId);
  const active = event.scouts.filter((s) => !s.eliminated);
  if (active.length < 2) return null;

  const heatSize = Math.min(Math.max(event.lanes, 2), active.length);
  if (heatSize < 2) return null;

  const pairCounts = await buildPairCounts(eventId);
  const candidateGroups = buildCandidateGroups(active, heatSize);

  let bestLaneAssignments: string[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const group of candidateGroups) {
    const lanePermutations = getPermutations(group);
    let bestGroupAssignment: any[] | null = null;
    let bestGroupLaneCost = Number.POSITIVE_INFINITY;

    for (const perm of lanePermutations) {
      const laneCost = perm.reduce((sum, scout, index) => {
        const lane = index + 1;
        return sum + laneBalanceScore(scout, lane);
      }, 0);

      if (laneCost < bestGroupLaneCost) {
        bestGroupLaneCost = laneCost;
        bestGroupAssignment = perm;
      }
    }

    if (!bestGroupAssignment) continue;

    let repeats = 0;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        repeats += pairCounts.get(pairKey(group[i].id, group[j].id)) ?? 0;
      }
    }

    const points = group.map((s) => s.points);
    const minPoints = Math.min(...points);
    const maxPoints = Math.max(...points);
    const pointSpread = maxPoints - minPoints;
    const pointAvg = points.reduce((sum, p) => sum + p, 0) / points.length;
    const pointDeviation = points.reduce((sum, p) => sum + Math.abs(p - pointAvg), 0);

    // Heuristic: balance lanes heavily, then keep racers close in points, then reduce repeat matchups.
    const score =
      bestGroupLaneCost * 200 +
      pointSpread * 120 +
      pointDeviation * 40 +
      repeats * 60;

    if (score < bestScore) {
      bestScore = score;
      bestLaneAssignments = bestGroupAssignment.map((s) => s.id);
    }
  }

  if (!bestLaneAssignments || bestLaneAssignments.length < 2) return null;

  const laneAssignments = bestLaneAssignments;
  
  // Update lane history for scouts
  for (let i = 0; i < laneAssignments.length; i += 1) {
    const scout = event.scouts.find((s) => s.id === laneAssignments[i]);
    if (!scout) continue;
    const history = safeParseJSON<number[]>(scout.laneHistory, []);
    history.push(i + 1);
    await prisma.scout.update({
      where: { id: scout.id },
      data: { laneHistory: JSON.stringify(history) }
    });
  }

  return await prisma.heat.create({
    data: {
      id: nanoid(8),
      eventId: event.id,
      laneAssignments: JSON.stringify(laneAssignments),
      finishOrder: "[]",
    }
  });
}

// --- Auth Routes ---

app.post("/api/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const { email, password, name } = parsed.data;
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: "Email already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
    });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    return res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ message: "Error creating user", details: (err as Error).message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const { email, password } = parsed.data;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    return res.status(500).json({ message: "Error logging in" });
  }
});

app.get("/api/auth/me", requireAuth as express.RequestHandler, async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ message: "Not authenticated" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    return res.status(500).json({ message: "Error fetching user info" });
  }
});

// --- Event Routes ---

app.post("/api/events", async (req: AuthRequest, res) => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const isGuest = !req.user || parsed.data.isGuest;
  const event = await prisma.event.create({
    data: {
      name: parsed.data.name,
      pointLimit: parsed.data.pointLimit,
      lanes: parsed.data.lanes,
      theme: parsed.data.theme,
      userId: req.user?.id || null,
      isGuest,
    },
    include: { scouts: true, heats: true },
  });

  return res.status(201).json(serializeEvent(event));
});

app.post("/api/events/:eventId/claim", requireAuth as express.RequestHandler, async (req: AuthRequest, res) => {
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

    publishEvent(updated.id);
    return res.json(serializeEvent(updated));
  } catch (err) {
    return res.status(500).json({ message: "Error claiming event" });
  }
});

app.post("/api/events/:eventId/guest-kiosk-link", requireAuth as express.RequestHandler, async (req: AuthRequest, res) => {
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
  return res.status(201).json({ token: link.token, expiresAt: link.expiresAt.getTime() });
});

app.delete("/api/events/:eventId/guest-kiosk-link", requireAuth as express.RequestHandler, async (req: AuthRequest, res) => {
  const eventId = req.params.eventId as string;
  if (!req.user) return res.status(401).json({ message: "Authentication required" });

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ message: "Event not found" });
  if (event.userId !== req.user.id) return res.status(403).json({ message: "Permission denied" });

  await (prisma as any).guestKioskLink.updateMany({
    where: { eventId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.status(204).send();
});

app.delete("/api/events/:eventId/guest", async (req: AuthRequest, res) => {
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

app.post("/api/guest-kiosk/:token", async (req, res) => {
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

app.post("/api/kiosk/bootstrap", async (req: AuthRequest, res) => {
  const token = nanoid(12);
  const expiresAt = new Date(Date.now() + kioskAccessTtlMs);

  await prisma.kioskSession.create({
    data: {
      token,
      expiresAt,
    },
  });

  return res.status(201).json({
    token,
    expiresAt: expiresAt.getTime(),
  });
});

app.post("/api/kiosk/sessions/:token/create-event", async (req: AuthRequest, res) => {
  const token = req.params.token as string;
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const session = await prisma.kioskSession.findUnique({
    where: { token }
  });
  if (!session) return res.status(404).json({ message: "Session not found" });
  if (session.eventId) return res.status(400).json({ message: "Session already has an event" });

  const isGuest = !req.user || parsed.data.isGuest;
  const event = await prisma.event.create({
    data: {
      name: parsed.data.name,
      pointLimit: parsed.data.pointLimit,
      lanes: parsed.data.lanes,
      theme: parsed.data.theme,
      userId: req.user?.id || null,
      isGuest,
    },
    include: { scouts: true, heats: true },
  });

  await prisma.kioskSession.update({
    where: { token },
    data: { eventId: event.id }
  });

  return res.status(201).json(serializeEvent(event));
});

app.get("/api/events/:eventId", async (req: AuthRequest, res) => {
  const eventId = req.params.eventId as string;
  try {
    const event = await getEventWithDetails(eventId);
    const allowed = await canReadEvent(req, { id: event.id, isGuest: event.isGuest, userId: event.userId });
    if (!allowed) return res.status(403).json({ message: "Authentication required to access this event" });
    return res.json(serializeEvent(event));
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.delete("/api/events/:eventId", requireAuth as express.RequestHandler, async (req: AuthRequest, res) => {
  const eventId = req.params.eventId as string;
  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Event not found" });
    if (event.userId !== req.user?.id) return res.status(403).json({ message: "Permission denied" });

    await prisma.event.delete({ where: { id: eventId } });
    return res.status(204).send();
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.get("/api/events", async (req: AuthRequest, res) => {
  let where = {};
  if (req.user) {
    where = { userId: req.user.id };
  } else {
    return res.json({ events: [] }); // Guest list is empty unless specific event requested
  }

  const allEvents = await prisma.event.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { scouts: true, heats: true },
  });
  return res.json({ events: allEvents.map((e) => serializeEvent(e)) });
});

app.patch("/api/events/:eventId", async (req, res) => {
  const parsed = updateEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  try {
    const access = await requireEventWriteAccess(req as AuthRequest, res, req.params.eventId);
    if (!access) return;
    const event = await prisma.event.update({
      where: { id: req.params.eventId },
      data: parsed.data,
      include: { scouts: true, heats: true }
    });
    publishEvent(event.id);
    return res.json(serializeEvent(event));
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.post("/api/events/:eventId/scouts", async (req, res) => {
  const parsed = addScoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  try {
    const access = await requireEventWriteAccess(req as AuthRequest, res, req.params.eventId);
    if (!access) return;
    const scout = await prisma.scout.create({
      data: {
        id: nanoid(10),
        name: parsed.data.name,
        carNumber: parsed.data.carNumber,
        eventId: req.params.eventId,
      }
    });
    publishEvent(req.params.eventId);
    return res.status(201).json(scout);
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.post("/api/events/:eventId/next-heat", async (req, res) => {
  try {
    const access = await requireEventWriteAccess(req as AuthRequest, res, req.params.eventId);
    if (!access) return;
    const event = await getEventWithDetails(req.params.eventId);
    const scouts = event.scouts.map(s => ({...s, laneHistory: safeParseJSON<number[]>(s.laneHistory, [])}));
    const active = scouts.filter(s => !s.eliminated);
    if (active.length <= 1) return res.status(400).json({ message: "Tournament is already complete" });
    
    const heat = await chooseNextHeat(req.params.eventId);
    if (!heat) return res.status(400).json({ message: "Cannot generate a valid heat with fewer than 2 active racers" });
    
    publishEvent(req.params.eventId);
    return res.status(201).json({
      ...heat,
      laneAssignments: safeParseJSON<string[]>(heat.laneAssignments, []),
      createdAt: heat.createdAt.getTime()
    });
  } catch (e) {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.post("/api/events/:eventId/heats/:heatId/result", async (req, res) => {
  const parsed = postResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  try {
    const access = await requireEventWriteAccess(req as AuthRequest, res, req.params.eventId);
    if (!access) return;
    const event = await getEventWithDetails(req.params.eventId);
    const heat = event.heats.find((h) => h.id === req.params.heatId);
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

    // Update heat
    await prisma.heat.update({
      where: { id: req.params.heatId },
      data: {
        finishOrder: JSON.stringify(finishOrder),
        winnerScoutId,
        loserScoutIds: JSON.stringify(loserScoutIds),
      }
    });

    // Update points for everyone in the heat
    for (let position = 0; position < finishOrder.length; position += 1) {
      const scoutId = finishOrder[position];
      const scout = event.scouts.find((s) => s.id === scoutId);
      if (!scout) continue;

      const newPoints = scout.points + position;
      await prisma.scout.update({
        where: { id: scoutId },
        data: {
          points: newPoints,
          eliminated: newPoints >= event.pointLimit
        }
      });
    }

    // Check if tournament is complete
    const updatedEvent = await getEventWithDetails(req.params.eventId);
    const activeScouts = updatedEvent.scouts.filter(s => !s.eliminated);
    if (activeScouts.length === 1 && !updatedEvent.completedAt) {
      await prisma.event.update({
        where: { id: req.params.eventId },
        data: { completedAt: new Date() }
      });
    }

    publishEvent(req.params.eventId);
    return res.status(200).json({ message: "Result saved" });
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

app.post("/api/kiosk/sessions", async (_req, res) => {
  const token = nanoid(12);
  const expiresAt = new Date(Date.now() + kioskAccessTtlMs);
  await prisma.kioskSession.create({
    data: { token, expiresAt }
  });
  return res.status(201).json({ token, expiresAt: expiresAt.getTime() });
});

app.get("/api/kiosk/sessions/:token", async (req, res) => {
  const token = req.params.token as string;
  const session = await prisma.kioskSession.findUnique({
    where: { token }
  });
  if (!session) return res.status(404).json({ message: "Session not found" });
  if (Date.now() > session.expiresAt.getTime()) {
    await prisma.kioskSession.delete({ where: { token } });
    return res.status(410).json({ message: "Session expired" });
  }
  return res.json({
    token: session.token,
    eventId: session.eventId ?? null,
    expiresAt: session.expiresAt.getTime(),
    isBound: Boolean(session.eventId),
  });
});

app.post("/api/kiosk/sessions/:token/bind", async (req, res) => {
  const token = req.params.token as string;
  const schema = z.object({ eventId: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const session = await prisma.kioskSession.findUnique({
    where: { token }
  });
  if (!session) return res.status(404).json({ message: "Session not found" });

  if (session.eventId && session.eventId !== parsed.data.eventId) {
    return res.status(400).json({ message: "Session is already bound to a different event" });
  }

  const target = await prisma.event.findUnique({
    where: { id: parsed.data.eventId },
    select: { id: true, isGuest: true, userId: true },
  });
  if (!target) return res.status(404).json({ message: "Event not found" });

  if (!(target.isGuest && !target.userId)) {
    const reqUser = (req as AuthRequest).user;
    if (!reqUser || target.userId !== reqUser.id) {
      return res.status(403).json({ message: "Authentication required to access this event" });
    }
  }
  
  await prisma.kioskSession.update({
    where: { token },
    data: { eventId: parsed.data.eventId }
  });
  
  return res.json({ token: session.token, eventId: parsed.data.eventId, isBound: true });
});

app.post("/api/kiosk/sessions/:token/pairing-request", async (req, res) => {
  const token = req.params.token as string;
  const session = await prisma.kioskSession.findUnique({
    where: { token }
  });
  if (!session) return res.status(404).json({ message: "Session not found" });

  const qrToken = nanoid(16);
  const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 2 * 60_000);

  await prisma.pairingRequest.create({
    data: {
      qrToken,
      pairingCode,
      kioskToken: session.token,
      expiresAt,
    }
  });
  
  return res.status(201).json({ qrToken, pairingCode, expiresAt: expiresAt.getTime() });
});

app.post("/api/kiosk/pair", async (req, res) => {
  const schema = z.object({
    qrToken: z.string().min(1),
    pairingCode: z.string().min(6).max(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const request = await prisma.pairingRequest.findUnique({
    where: { qrToken: parsed.data.qrToken }
  });
  if (!request) return res.status(404).json({ message: "Pairing request not found or expired" });

  if (Date.now() > request.expiresAt.getTime()) {
    await prisma.pairingRequest.delete({ where: { qrToken: parsed.data.qrToken } });
    return res.status(410).json({ message: "Pairing request expired" });
  }

  if (request.pairingCode !== parsed.data.pairingCode) {
    return res.status(401).json({ message: "Invalid pairing code" });
  }

  const session = await prisma.kioskSession.findUnique({
    where: { token: request.kioskToken }
  });
  if (!session) return res.status(404).json({ message: "Session not found" });

  await prisma.kioskSession.update({
    where: { token: session.token },
    data: { expiresAt: new Date(Date.now() + kioskAccessTtlMs), accessExpiresAt: new Date(Date.now() + kioskAccessTtlMs) },
  });

  await prisma.pairingRequest.delete({ where: { qrToken: parsed.data.qrToken } });

  if (session.eventId) {
    io.to(session.eventId).emit("kiosk:paired");
  }

  return res.json({
    token: session.token,
    eventId: session.eventId ?? null,
    expiresAt: Date.now() + kioskAccessTtlMs,
  });
});

app.get("/api/events/:eventId/results", async (req, res) => {
  try {
    const access = await requireEventReadAccess(req as AuthRequest, res, req.params.eventId);
    if (!access) return;
    const event = await getEventWithDetails(req.params.eventId);
    const scoutsById = new Map(event.scouts.map((s) => [s.id, s]));
    const serialized = serializeEvent(event);
    
    return res.json({
      event: serialized,
      completedAt: event.completedAt?.getTime() ?? null,
      champion: serialized.championScoutId ? scoutsById.get(serialized.championScoutId) : null,
      heatResults: event.heats.map((heat: any) => ({
        id: heat.id,
        createdAt: heat.createdAt.getTime(),
        placements: safeParseJSON<string[]>(heat.finishOrder, []).map((scoutId, index) => ({
          place: index + 1,
          scout: scoutsById.get(scoutId) ?? null,
        })),
        winnerScoutId: heat.winnerScoutId ?? null,
        loserScoutIds: safeParseJSON<string[]>(heat.loserScoutIds, []),
      })),
    });
  } catch {
    return res.status(404).json({ message: "Event not found" });
  }
});

io.on("connection", (socket) => {
  socket.on("event:subscribe", async (payload: unknown) => {
    const parsed = z
      .object({
        eventId: z.string().min(1),
        authToken: z.string().min(1).optional().nullable(),
        kioskToken: z.string().min(1).optional().nullable(),
      })
      .safeParse(typeof payload === "string" ? { eventId: payload } : payload);

    if (!parsed.success) return;
    const { eventId, authToken, kioskToken } = parsed.data;

    let userId: string | null = null;
    if (authToken) {
      try {
        const jwtPayload = jwt.verify(authToken, JWT_SECRET) as { id: string; email: string };
        userId = jwtPayload.id;
      } catch {
        userId = null;
      }
    }

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, isGuest: true, userId: true },
    });
    if (!event) return;

    if (event.isGuest && !event.userId) {
      socket.join(eventId);
      try {
        const full = await getEventWithDetails(eventId);
        socket.emit("event:update", serializeEvent(full));
      } catch {}
      return;
    }

    if (userId && event.userId === userId) {
      socket.join(eventId);
      try {
        const full = await getEventWithDetails(eventId);
        socket.emit("event:update", serializeEvent(full));
      } catch {}
      return;
    }

    if (kioskToken) {
      const session = (await prisma.kioskSession.findUnique({ where: { token: kioskToken } })) as any;
      if (!session) return;
      if (Date.now() > session.expiresAt.getTime()) return;
      if (session.eventId !== eventId) return;

      if (event.userId) {
        if (!session.accessExpiresAt) return;
        if (Date.now() > session.accessExpiresAt.getTime()) return;
        if (session.guestKioskLinkId) {
          const link = (await (prisma as any).guestKioskLink.findUnique({
            where: { id: session.guestKioskLinkId },
            select: { revokedAt: true, expiresAt: true },
          })) as { revokedAt: Date | null; expiresAt: Date } | null;
          if (!link) return;
          if (link.revokedAt) return;
          if (Date.now() > link.expiresAt.getTime()) return;
        }
      }

      socket.join(eventId);
      try {
        const full = await getEventWithDetails(eventId);
        socket.emit("event:update", serializeEvent(full));
      } catch {}
    }
  });
});

const port = Number(process.env.PORT ?? 8787);

// Periodic cleanup
setInterval(async () => {
  const now = new Date();
  await prisma.pairingRequest.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.kioskSession.deleteMany({ where: { expiresAt: { lt: now } } });
}, 60_000);

httpServer.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
