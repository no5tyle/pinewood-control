/*
  Server entrypoint.

  Responsibilities:
  - Create Express app + HTTP server
  - Configure CORS and global middleware (JSON parsing, auth, rate limiting)
  - Create Socket.IO server and register socket handlers
  - Register themed route modules (auth, patrols, kiosk, events)
  - Run periodic cleanup tasks

  Most implementation details live in ./server/* to keep this file small.
*/
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { allowAllOrigins, allowedOriginSet, corsOrigins, JWT_SECRET, guestEventTtlMs, port } from "./server/config.js";
import { authenticate } from "./server/auth.js";
import { createEngineRateLimiter, createRateLimiter } from "./server/rateLimit.js";
import { purgeExpiredGuestEvents } from "./server/purge.js";
import { registerSocketHandlers } from "./server/socketHandlers.js";
import { registerAuthRoutes } from "./server/routes/authRoutes.js";
import { registerPatrolRoutes } from "./server/routes/patrolRoutes.js";
import { registerKioskRoutes } from "./server/routes/kioskRoutes.js";
import { registerEventRoutes } from "./server/routes/eventRoutes.js";
import { startPeriodicCleanup } from "./server/cleanup.js";

const prisma = new PrismaClient();
const app = express();
app.set("trust proxy", true);

const corsOptions = allowAllOrigins
  ? undefined
  : {
      origin: (origin: string | undefined, callback: (err: Error | null, allowed?: boolean) => void) => {
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/+$/, "");
        if (allowedOriginSet.has(normalized)) return callback(null, true);
        return callback(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
    };

app.use(cors(corsOptions));
app.use(express.json());
app.get("/api/health", (_req, res) => {
  return res.json({ ok: true, time: Date.now() });
});
app.use(createRateLimiter({ windowMs: 60_000, max: 300, keyPrefix: "api" }));
app.use(authenticate(JWT_SECRET) as unknown as express.RequestHandler);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: allowAllOrigins
    ? { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
    : {
        origin: corsOrigins,
        credentials: true,
        methods: ["GET", "POST", "PATCH", "DELETE"],
      },
});

io.engine.use(createEngineRateLimiter({ windowMs: 60_000, max: 600, keyPrefix: "socket" }));

registerSocketHandlers({ io, prisma, JWT_SECRET });
registerAuthRoutes({ app, prisma, JWT_SECRET });
registerPatrolRoutes({ app, prisma });
registerKioskRoutes({ app, prisma, io });
registerEventRoutes({ app, prisma, io });

startPeriodicCleanup(prisma);

void purgeExpiredGuestEvents(prisma, guestEventTtlMs).catch(() => undefined);
setInterval(() => {
  void purgeExpiredGuestEvents(prisma, guestEventTtlMs).catch(() => undefined);
}, 15 * 60_000);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  const message = err instanceof Error ? err.message : "Server error";
  return res.status(500).json({ message });
});

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => {
    prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  });
});
