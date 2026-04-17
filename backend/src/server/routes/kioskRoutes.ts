/*
  Kiosk + pairing routes.

  Usage:
  - registerKioskRoutes({ app, prisma, io }) is called from server.ts
  - Provides endpoints used by the kiosk screen and operator pairing flow:
    - kiosk session creation/lookup/bind
    - pairing request + pairing confirmation
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import type { Server } from "socket.io";
import { nanoid } from "nanoid";
import { z } from "zod";
import { kioskAccessTtlMs } from "../config.js";
import { createEventSchema } from "../schemas.js";
import { createRateLimiter, getClientIp } from "../rateLimit.js";
import { getEventWithDetails, serializeEvent } from "../eventService.js";

export function registerKioskRoutes(options: { app: Express; prisma: PrismaClient; io: Server }) {
  const { app, prisma, io } = options;

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

  app.post("/api/kiosk/bootstrap", kioskBootstrapLimiter, async (_req, res) => {
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

  app.post("/api/kiosk/sessions", kioskSessionCreateLimiter, async (_req, res) => {
    const token = nanoid(12);
    const expiresAt = new Date(Date.now() + kioskAccessTtlMs);
    await prisma.kioskSession.create({
      data: { token, expiresAt },
    });
    return res.status(201).json({ token, expiresAt: expiresAt.getTime() });
  });

  app.get("/api/kiosk/sessions/:token", kioskSessionLookupLimiter, async (req, res) => {
    const token = req.params.token as string;
    const session = await prisma.kioskSession.findUnique({
      where: { token },
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

  app.post("/api/kiosk/sessions/refresh", kioskSessionRefreshLimiter, async (req, res) => {
    const token = req.header("x-kiosk-token");
    if (!token) return res.status(400).json({ message: "Missing kiosk token" });

    const session = await prisma.kioskSession.findUnique({ where: { token } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (Date.now() > session.expiresAt.getTime()) {
      await prisma.kioskSession.delete({ where: { token } });
      return res.status(410).json({ message: "Session expired" });
    }

    const nextExpiresAt = new Date(Date.now() + kioskAccessTtlMs);
    const updated = await prisma.kioskSession.update({
      where: { token },
      data: {
        expiresAt: nextExpiresAt,
        accessExpiresAt: session.eventId ? nextExpiresAt : session.accessExpiresAt,
      } as any,
    });

    return res.json({
      token: updated.token,
      eventId: updated.eventId ?? null,
      expiresAt: updated.expiresAt.getTime(),
      accessExpiresAt: updated.accessExpiresAt ? updated.accessExpiresAt.getTime() : null,
      isBound: Boolean(updated.eventId),
    });
  });

  app.post("/api/kiosk/sessions/:token/bind", kioskSessionBindLimiter, async (req, res) => {
    const token = req.params.token as string;
    const schema = z.object({ eventId: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const session = await prisma.kioskSession.findUnique({
      where: { token },
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
      const reqUser = (req as any).user;
      if (!reqUser || target.userId !== reqUser.id) {
        return res.status(403).json({ message: "Authentication required to access this event" });
      }
    }

    await prisma.kioskSession.update({
      where: { token },
      data: { eventId: parsed.data.eventId },
    });

    return res.json({ token: session.token, eventId: parsed.data.eventId, isBound: true });
  });

  app.post("/api/kiosk/sessions/:token/create-event", kioskSessionCreateEventLimiter, async (req, res) => {
    const token = req.params.token as string;
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const session = await prisma.kioskSession.findUnique({
      where: { token },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.eventId) return res.status(400).json({ message: "Session already has an event" });

    const isGuest = !(req as any).user || parsed.data.isGuest;
    const event = await prisma.event.create({
      data: {
        name: parsed.data.name,
        pointLimit: parsed.data.pointLimit,
        lanes: parsed.data.lanes,
        theme: parsed.data.theme,
        weightUnit: parsed.data.weightUnit,
        userId: (req as any).user?.id || null,
        isGuest,
      },
      include: { scouts: true, heats: true },
    });

    await prisma.kioskSession.update({
      where: { token },
      data: { eventId: event.id },
    });

    const fullEvent = await getEventWithDetails(prisma, event.id);
    return res.status(201).json(serializeEvent(fullEvent));
  });

  app.post("/api/kiosk/sessions/:token/pairing-request", kioskPairingRequestLimiter, async (req, res) => {
    const token = req.params.token as string;
    const session = await prisma.kioskSession.findUnique({
      where: { token },
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
      },
    });

    return res.status(201).json({ qrToken, pairingCode, expiresAt: expiresAt.getTime() });
  });

  app.post("/api/kiosk/pair", kioskPairLimiter, async (req, res) => {
    const schema = z.object({
      qrToken: z.string().min(1),
      pairingCode: z.string().min(6).max(6),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const request = await prisma.pairingRequest.findUnique({
      where: { qrToken: parsed.data.qrToken },
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
      where: { token: request.kioskToken },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });

    await prisma.kioskSession.update({
      where: { token: session.token },
      data: { expiresAt: new Date(Date.now() + kioskAccessTtlMs), accessExpiresAt: new Date(Date.now() + kioskAccessTtlMs) } as any,
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
}
