/*
  Auth routes.

  Usage:
  - registerAuthRoutes({ app, prisma, JWT_SECRET }) is called from server.ts
  - Provides:
    - POST /api/auth/register
    - POST /api/auth/login
    - GET  /api/auth/me
*/
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import express from "express";
import { registerSchema, loginSchema } from "../schemas.js";
import { createRateLimiter, getClientIp } from "../rateLimit.js";
import { requireAuth } from "../auth.js";

export function registerAuthRoutes(options: { app: Express; prisma: PrismaClient; JWT_SECRET: string }) {
  const { app, prisma, JWT_SECRET } = options;

  const registerLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: 5,
    keyPrefix: "auth-register",
    keyFn: (req) => {
      const email = typeof (req as any).body?.email === "string" ? (req as any).body.email.toLowerCase().trim() : "";
      return `${getClientIp(req)}:${email}`;
    },
  });

  const loginLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    max: 30,
    keyPrefix: "auth-login",
    keyFn: (req) => {
      const email = typeof (req as any).body?.email === "string" ? (req as any).body.email.toLowerCase().trim() : "";
      return `${getClientIp(req)}:${email}`;
    },
  });

  app.post("/api/auth/register", registerLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { email, password, name } = parsed.data;
    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(400).json({ message: "Email already exists" });

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: { email, passwordHash, name },
      });

      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
      return res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      console.error("Signup error:", err);
      return res.status(500).json({ message: "Error creating user", details: (err as Error).message });
    }
  });

  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { email, password } = parsed.data;
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch {
      return res.status(500).json({ message: "Error logging in" });
    }
  });

  app.get("/api/auth/me", requireAuth as express.RequestHandler, async (req: any, res) => {
    if (!req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json({ id: user.id, email: user.email, name: user.name });
    } catch {
      return res.status(500).json({ message: "Error fetching user info" });
    }
  });
}
