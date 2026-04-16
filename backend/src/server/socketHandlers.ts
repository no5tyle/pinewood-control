/*
  Socket.IO handlers.

  Usage:
  - server.ts calls registerSocketHandlers({ io, prisma, JWT_SECRET })
  - Clients emit "event:subscribe" with eventId plus either:
    - authToken (account owner), or
    - kioskToken (paired kiosk/operator session)
  - If access checks pass, the socket joins the room for that eventId and receives live "event:update" messages.
*/
import type { PrismaClient } from "@prisma/client";
import type { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getEventWithDetails, serializeEvent } from "./eventService.js";

export function registerSocketHandlers(options: { io: Server; prisma: PrismaClient; JWT_SECRET: string }) {
  const { io, prisma, JWT_SECRET } = options;

  io.on("connection", (socket) => {
    socket.on("event:subscribe", (payload: unknown) => {
      void (async () => {
        try {
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

          const emitFull = async () => {
            try {
              const full = await getEventWithDetails(prisma, eventId);
              socket.emit("event:update", serializeEvent(full));
            } catch {
              void 0;
            }
          };

          if (event.isGuest && !event.userId) {
            socket.join(eventId);
            await emitFull();
            return;
          }

          if (userId && event.userId === userId) {
            socket.join(eventId);
            await emitFull();
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
            await emitFull();
          }
        } catch (err) {
          console.error("Unhandled socket error", err);
        }
      })();
    });
  });
}
