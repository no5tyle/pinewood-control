/*
  Settings from environment variables.

  - CORS_ORIGIN: the app's address(es), comma-separated (empty allows any origin, for local runs)
  - PORT: where to listen (Cloud Run sets it)
*/
const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim();
export const corsOrigins = corsOrigin.length > 0
  ? corsOrigin
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  : [];

export const kioskAccessTtlMs = 3 * 60 * 60_000;

export const port = Number(process.env.PORT ?? 8787);
