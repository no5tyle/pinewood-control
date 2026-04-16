/*
  In-memory rate limiting.

  Usage:
  - createRateLimiter(...) returns an Express middleware for HTTP routes.
  - createEngineRateLimiter(...) is used with io.engine.use(...) for Socket.IO transport-level limiting.

  Notes:
  - This is intentionally simple (memory-based). In multi-instance deployments, place a proxy/CDN limit
    in front or replace this with a shared store.
*/
import type { Request, Response, NextFunction } from "express";

type RateLimitState = { count: number; resetAtMs: number };

export function getClientIp(req: Pick<Request, "headers" | "ip">): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim().length > 0) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length > 0 && xff[0].trim().length > 0) return xff[0].split(",")[0].trim();
  return req.ip || "unknown";
}

export function createRateLimiter(options: { windowMs: number; max: number; keyPrefix: string; keyFn?: (req: Request) => string }) {
  const store = new Map<string, RateLimitState>();
  const { windowMs, max, keyPrefix, keyFn } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();

    const now = Date.now();
    const baseKey = keyFn ? keyFn(req) : getClientIp(req);
    const key = `${keyPrefix}:${baseKey}`;
    const state = store.get(key);
    if (!state || now >= state.resetAtMs) {
      store.set(key, { count: 1, resetAtMs: now + windowMs });
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - 1)));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }

    state.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - state.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(state.resetAtMs / 1000)));

    if (state.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAtMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ message: "Too many requests" });
    }

    return next();
  };
}

export function createEngineRateLimiter(options: { windowMs: number; max: number; keyPrefix: string }) {
  const store = new Map<string, RateLimitState>();
  const { windowMs, max, keyPrefix } = options;

  return (req: any, res: any, next: (err?: any) => void) => {
    const method = (req.method as string | undefined) ?? "GET";
    if (method === "OPTIONS") return next();

    const now = Date.now();
    const ip = getClientIp({ headers: req.headers ?? {}, ip: req.socket?.remoteAddress ?? "unknown" } as any);
    const key = `${keyPrefix}:${ip}`;
    const state = store.get(key);
    if (!state || now >= state.resetAtMs) {
      store.set(key, { count: 1, resetAtMs: now + windowMs });
      return next();
    }

    state.count += 1;
    if (state.count > max) {
      try {
        res.statusCode = 429;
        res.setHeader("Content-Type", "text/plain");
        res.end("Too many requests");
      } catch {
        void 0;
      }
      return;
    }
    return next();
  };
}
