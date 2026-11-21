/*
  Socket.IO handlers.

  - Clients emit "event:subscribe" with eventId plus either authToken (the account's Firebase ID token)
    or kioskToken (a paired kiosk or phone).
  - If they may see the event, the socket joins the room for that eventId, gets the event straight away,
    and then every "event:update".

  Cloud Run bills for every second a connection is open, so the server closes the ones with nothing to do,
  whatever the page asks:
  - A page from before connections were kept short (it doesn't say `auth: { v: 2 }`) is closed straight away.
    Socket.IO doesn't reconnect after the server closes it, so an old tab left open stops costing anything.
  - A connection whose events haven't changed (and which hasn't subscribed) for 30 minutes is closed. Today's
    pages then look once a minute, and connect again when something changes or someone taps the screen.
*/
import type { Server } from "socket.io";
import { z } from "zod";
import { canAccessEvent, type Auth } from "./auth.js";
import { lastActivity, noteActivity, serializeEvent } from "./eventService.js";
import { collections, type Db } from "./store/db.js";
import type { EventDoc } from "./store/types.js";

const subscribeSchema = z.object({
  eventId: z.string().min(1),
  authToken: z.string().min(1).optional().nullable(),
  kioskToken: z.string().min(1).optional().nullable(),
});

/** How long a connection is kept with nothing happening. */
export const IDLE_CLOSE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;

/** Closes connections with nothing to follow: none of their events changed, and no subscribe, for 30 minutes. */
export function closeIdle(io: Server, now = Date.now()) {
  let closed = 0;
  for (const socket of io.of("/").sockets.values()) {
    const since = Math.max(socket.data.lastSeen ?? 0, ...[...socket.rooms].map((r) => lastActivity.get(r) ?? 0));
    if (now - since >= IDLE_CLOSE_MS) { socket.disconnect(true); closed++; }
  }
  return closed;
}

export function registerSocketHandlers(options: { io: Server; db: Db; auth: Auth }) {
  const { io, db, auth } = options;
  const sweep = setInterval(() => closeIdle(io), SWEEP_MS);
  sweep.unref?.();
  io.engine.on("close", () => clearInterval(sweep));

  io.on("connection", (socket) => {
    // A page from before connections were kept short: closed now (it won't reconnect)
    if ((socket.handshake.auth as { v?: number } | undefined)?.v !== 2) { socket.disconnect(true); return; }
    socket.data.lastSeen = Date.now();
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
          socket.data.lastSeen = Date.now();
          if (!lastActivity.has(eventId)) noteActivity(eventId);
          socket.emit("event:update", serializeEvent(event));
        } catch (err) {
          console.error("Unhandled socket error", err);
        }
      })();
    });
  });
}
