/*
  The Pinewood API: an Express app with Socket.IO for the live screens.

  createApp gets where data is kept (Firestore, or memory in tests) and how to check sign-ins, so the
  same app runs in production and in the tests.
*/
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { authenticate, type Auth } from "./server/auth.js";
import { createEngineRateLimiter, createRateLimiter } from "./server/rateLimit.js";
import { registerSocketHandlers } from "./server/socketHandlers.js";
import { registerPatrolRoutes } from "./server/routes/patrolRoutes.js";
import { registerRaceSetupRoutes } from "./server/routes/raceSetupRoutes.js";
import { registerKioskRoutes } from "./server/routes/kioskRoutes.js";
import { registerEventRoutes } from "./server/routes/eventRoutes.js";
import { HttpError, type Db } from "./server/store/db.js";

export function createApp(options: { db: Db; auth: Auth; corsOrigins: string[] }) {
  const { db, auth, corsOrigins } = options;
  const allowedOrigins = new Set(corsOrigins);
  const allowAll = corsOrigins.length === 0;

  const app = express();
  app.set("trust proxy", 1);
  app.use(
    cors(
      allowAll
        ? undefined
        : {
            origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin.replace(/\/+$/, ""))),
            credentials: true,
          },
    ),
  );
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });
  app.use(createRateLimiter({ windowMs: 60_000, max: 300, keyPrefix: "api" }));
  app.use(authenticate(auth));

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: allowAll
      ? { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
      : { origin: corsOrigins, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE"] },
  });
  io.engine.use(createEngineRateLimiter({ windowMs: 60_000, max: 600, keyPrefix: "socket" }));

  registerSocketHandlers({ io, db, auth });
  registerPatrolRoutes({ app, db });
  registerRaceSetupRoutes({ app, db });
  registerKioskRoutes({ app, db, io });
  registerEventRoutes({ app, db, io });

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ message: "Not found" });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ message: err.message });
    if ((err as { type?: string }).type === "entity.parse.failed") return void res.status(400).json({ message: "Invalid JSON" });
    console.error("Unhandled error:", err);
    res.status(500).json({ message: "Server error" });
  });

  return { app, httpServer, io };
}
