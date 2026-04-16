/*
  Centralized config derived from environment variables.

  This module is imported by the server entrypoint and route/socket modules.
  It is intentionally small and side-effect free so it can be reused in tests.
*/
export const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim();
export const corsOrigins = corsOrigin.length > 0
  ? corsOrigin
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : [];

export const allowAllOrigins = corsOrigins.length === 0;
export const allowedOriginSet = new Set(corsOrigins);

export const kioskAccessTtlMs = 3 * 60 * 60_000;
export const guestEventTtlMs = 24 * 60 * 60_000;

export const port = Number(process.env.PORT ?? 8787);
