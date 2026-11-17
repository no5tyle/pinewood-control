/*
  Socket.IO handlers.

  - Clients emit "event:subscribe" with eventId plus either authToken (the account's Firebase ID token)
    or kioskToken (a paired kiosk or phone).
  - If they may see the event, the socket joins the room for that eventId, gets the event straight away,
    and then every "event:update".
*/
import type { Server } from "socket.io";
import { z } from "zod";
import { canAccessEvent, type Auth } from "./auth.js";
import { serializeEvent } from "./eventService.js";
import { collections, type Db } from "./store/db.js";
import type { EventDoc } from "./store/types.js";

const subscribeSchema = z.object({
  eventId: z.string().min(1),
  authToken: z.string().min(1).optional().nullable(),
  kioskToken: z.string().min(1).optional().nullable(),
});

export function registerSocketHandlers(options: { io: Server; db: Db; auth: Auth }) {
  const { io, db, auth } = options;

  io.on("connection", (socket) => {
    socket.on("event:subscribe", (payload: unknown) => {
      void (async () => {
        try {
          const parsed = subscribeSchema.safeParse(typeof payload === "string" ? { eventId: payload } : payload);
          if (!parsed.success) return;
          const { eventId, authToken, kioskToken } = parsed.data;

          const user = authToken ? await auth.verify(authToken) : null;
          const event = await db.get<EventDoc>(collections.events, eventId);
          if (!event) return;
          if (!(await canAccessEvent(db, { userId: user?.id ?? null, kioskToken }, event, false))) return;

          await socket.join(eventId);
          socket.emit("event:update", serializeEvent(event));
        } catch (err) {
          console.error("Unhandled socket error", err);
        }
      })();
    });
  });
}
