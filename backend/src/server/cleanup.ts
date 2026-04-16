/*
  Periodic DB cleanup for short-lived records.

  Usage:
  - server.ts calls startPeriodicCleanup(prisma) once at boot.
  - Removes expired pairing requests and kiosk sessions.
*/
import type { PrismaClient } from "@prisma/client";

export function startPeriodicCleanup(prisma: PrismaClient) {
  setInterval(() => {
    void (async () => {
      try {
        const now = new Date();
        await prisma.pairingRequest.deleteMany({ where: { expiresAt: { lt: now } } });
        await prisma.kioskSession.deleteMany({ where: { expiresAt: { lt: now } } });
      } catch (err) {
        console.error("Periodic cleanup error", err);
      }
    })();
  }, 60_000);
}
