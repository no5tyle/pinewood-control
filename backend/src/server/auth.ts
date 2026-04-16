/*
  Authentication + event access control.

  Usage:
  - server.ts installs authenticate(JWT_SECRET) once, which populates req.user for Bearer tokens.
  - Routes then call requireAuth for account-only endpoints, or requireEventReadAccess / requireEventWriteAccess
    to gate event endpoints for guest, owner, or kiosk-session access.
*/
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: { id: string; email: string };
}

export function authenticate(JWT_SECRET: string) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.split(" ")[1];
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
      req.user = payload;
      next();
    } catch {
      next();
    }
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}

export async function canReadEvent(
  prisma: PrismaClient,
  req: AuthRequest,
  event: { id: string; isGuest: boolean; userId: string | null }
): Promise<boolean> {
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

export async function canWriteEvent(
  prisma: PrismaClient,
  req: AuthRequest,
  event: { id: string; isGuest: boolean; userId: string | null }
): Promise<boolean> {
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

export async function requireEventReadAccess(
  prisma: PrismaClient,
  req: AuthRequest,
  res: Response,
  eventId: string
): Promise<{ id: string; isGuest: boolean; userId: string | null } | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, isGuest: true, userId: true },
  });
  if (!event) {
    res.status(404).json({ message: "Event not found" });
    return null;
  }
  const allowed = await canReadEvent(prisma, req, event);
  if (!allowed) {
    res.status(403).json({ message: "Authentication required to access this event" });
    return null;
  }
  return event;
}

export async function requireEventWriteAccess(
  prisma: PrismaClient,
  req: AuthRequest,
  res: Response,
  eventId: string
): Promise<{ id: string; isGuest: boolean; userId: string | null } | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, isGuest: true, userId: true },
  });
  if (!event) {
    res.status(404).json({ message: "Event not found" });
    return null;
  }
  const allowed = await canWriteEvent(prisma, req, event);
  if (!allowed) {
    res.status(403).json({ message: "Authentication required to access this event" });
    return null;
  }
  return event;
}
