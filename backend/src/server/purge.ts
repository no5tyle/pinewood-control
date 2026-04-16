/*
  Guest-event retention.

  Usage:
  - server.ts calls purgeExpiredGuestEvents periodically.
  - Only deletes unclaimed guest events (isGuest=true AND userId=null) older than the configured TTL.
*/
import type { PrismaClient } from "@prisma/client";

export async function purgeExpiredGuestEvents(prisma: PrismaClient, guestEventTtlMs: number) {
  const cutoff = new Date(Date.now() - guestEventTtlMs);
  await prisma.event.deleteMany({
    where: {
      isGuest: true,
      userId: null,
      createdAt: { lt: cutoff },
    },
  });
}
