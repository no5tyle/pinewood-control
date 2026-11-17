/*
  Kiosk + pairing routes.

  - kiosk sessions: create, look up, refresh, bind to an event, make an event
  - pairing: the kiosk shows a QR code and a 6-digit code; a phone that scans it and types the code
    joins the kiosk's session
*/
import type { Express } from "express";
import type { Server } from "socket.io";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AuthRequest } from "../auth.js";
import { kioskAccessTtlMs } from "../config.js";
import { loadEvent, newEvent, serializeEvent } from "../eventService.js";
import { createEventSchema } from "../schemas.js";
import { createRateLimiter, getClientIp } from "../rateLimit.js";
import { collections, HttpError, type Db } from "../store/db.js";
import type { KioskSessionDoc, PairingDoc } from "../store/types.js";

const PAIRING_TTL_MS = 2 * 60_000;

export function registerKioskRoutes(options: { app: Express; db: Db; io: Server }) {
  const { app, db, io } = options;

  const kioskBootstrapLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30, keyPrefix: "kiosk-bootstrap" });
  const kioskSessionCreateLimiter = createRateLimiter({ windowMs: 60_000, max: 60, keyPrefix: "kiosk-session-create" });
  const kioskSessionLookupLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyPrefix: "kiosk-session-lookup" });
  const kioskSessionBindLimiter = createRateLimiter({ windowMs: 60_000, max: 60, keyPrefix: "kiosk-session-bind" });
  const kioskSessionRefreshLimiter = createRateLimiter({ windowMs: 60_000, max: 60, keyPrefix: "kiosk-session-refresh" });
  const kioskSessionCreateEventLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20, keyPrefix: "kiosk-session-create-event" });
  const kioskPairingRequestLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyPrefix: "kiosk-pairing-request",
    keyFn: (req) => `${getClientIp(req)}:${(req as any).params?.token ?? ""}`,
  });
  const kioskPairLimiter = createRateLimiter({ windowMs: 60_000, max: 20, keyPrefix: "kiosk-pair" });

  const saveSession = (session: KioskSessionDoc) =>
    db.set(collections.kioskSessions, session.token, { ...session, expireAt: new Date(session.expiresAt) });

  const createSession = async () => {
    const expiresAt = Date.now() + kioskAccessTtlMs;
    const session: KioskSessionDoc = {
      token: nanoid(12),
      expiresAt,
      accessExpiresAt: null,
      eventId: null,
      guestKioskLinkId: null,
      expireAt: new Date(expiresAt),
    };
    await saveSession(session);
    return { token: session.token, expiresAt };
  };

  /** The session, or 404. With `live`, 410 (and gone) once expired. */
  const sessionFor = async (token: string, live = false) => {
    const session = await db.get<KioskSessionDoc>(collections.kioskSessions, token);
    if (!session) throw new HttpError(404, "Session not found");
    if (live && Date.now() > session.expiresAt) {
      await db.delete(collections.kioskSessions, token);
      throw new HttpError(410, "Session expired");
    }
    return session;
  };

  app.post("/api/kiosk/bootstrap", kioskBootstrapLimiter, async (_req, res) => {
    return res.status(201).json(await createSession());
  });

  app.post("/api/kiosk/sessions", kioskSessionCreateLimiter, async (_req, res) => {
    return res.status(201).json(await createSession());
  });

  app.get("/api/kiosk/sessions/:token", kioskSessionLookupLimiter, async (req, res) => {
    const session = await sessionFor(req.params.token as string, true);
    return res.json({
      token: session.token,
      eventId: session.eventId ?? null,
      expiresAt: session.expiresAt,
      isBound: Boolean(session.eventId),
    });
  });

  app.post("/api/kiosk/sessions/refresh", kioskSessionRefreshLimiter, async (req, res) => {
    const token = req.header("x-kiosk-token");
    if (!token) throw new HttpError(400, "Missing kiosk token");
    const session = await sessionFor(token, true);

    const next = Date.now() + kioskAccessTtlMs;
    const updated = { ...session, expiresAt: next, accessExpiresAt: session.eventId ? next : session.accessExpiresAt };
    await saveSession(updated);
    return res.json({
      token: updated.token,
      eventId: updated.eventId ?? null,
      expiresAt: updated.expiresAt,
      accessExpiresAt: updated.accessExpiresAt ?? null,
      isBound: Boolean(updated.eventId),
    });
  });

  app.post("/api/kiosk/sessions/:token/bind", kioskSessionBindLimiter, async (req: AuthRequest, res) => {
    const parsed = z.object({ eventId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const session = await sessionFor(req.params.token as string);
    if (session.eventId && session.eventId !== parsed.data.eventId) {
      throw new HttpError(400, "Session is already bound to a different event");
    }
    const target = await loadEvent(db, parsed.data.eventId);
    if (!(target.isGuest && !target.userId) && (!req.user || target.userId !== req.user.id)) {
      throw new HttpError(403, "Authentication required to access this event");
    }

    await saveSession({ ...session, eventId: target.id });
    return res.json({ token: session.token, eventId: target.id, isBound: true });
  });

  app.post("/api/kiosk/sessions/:token/create-event", kioskSessionCreateEventLimiter, async (req: AuthRequest, res) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const session = await sessionFor(req.params.token as string);
    if (session.eventId) throw new HttpError(400, "Session already has an event");

    const { isGuest, ...fields } = parsed.data;
    const event = newEvent(nanoid(), { ...fields, userId: req.user?.id ?? null, isGuest: !req.user || isGuest });
    await db.set(collections.events, event.id, event);
    await saveSession({ ...session, eventId: event.id });
    return res.status(201).json(serializeEvent(event));
  });

  app.post("/api/kiosk/sessions/:token/pairing-request", kioskPairingRequestLimiter, async (req, res) => {
    const session = await sessionFor(req.params.token as string);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const pairing: PairingDoc = {
      qrToken: nanoid(16),
      pairingCode: Math.floor(100000 + Math.random() * 900000).toString(),
      kioskToken: session.token,
      expiresAt,
      expireAt: new Date(expiresAt),
    };
    await db.set(collections.pairings, pairing.qrToken, pairing);
    return res.status(201).json({ qrToken: pairing.qrToken, pairingCode: pairing.pairingCode, expiresAt });
  });

  app.post("/api/kiosk/pair", kioskPairLimiter, async (req, res) => {
    const parsed = z.object({ qrToken: z.string().min(1), pairingCode: z.string().min(6).max(6) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const request = await db.get<PairingDoc>(collections.pairings, parsed.data.qrToken);
    if (!request) throw new HttpError(404, "Pairing request not found or expired");
    if (Date.now() > request.expiresAt) {
      await db.delete(collections.pairings, request.qrToken);
      throw new HttpError(410, "Pairing request expired");
    }
    if (request.pairingCode !== parsed.data.pairingCode) throw new HttpError(401, "Invalid pairing code");

    const session = await sessionFor(request.kioskToken);
    const expiresAt = Date.now() + kioskAccessTtlMs;
    await saveSession({ ...session, expiresAt, accessExpiresAt: expiresAt });
    await db.delete(collections.pairings, request.qrToken);

    if (session.eventId) io.to(session.eventId).emit("kiosk:paired");
    return res.json({ token: session.token, eventId: session.eventId ?? null, expiresAt });
  });
}
