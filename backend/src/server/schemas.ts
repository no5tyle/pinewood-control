/*
  Request payload validation (Zod schemas).

  Usage:
  - Route handlers call schema.safeParse(req.body) and return 400 if invalid.
  - Keeping these in one file makes API surface easy to review and update consistently.
*/
import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const createEventSchema = z.object({
  name: z.string().min(2),
  pointLimit: z.number().int().min(1).max(200).default(10),
  lanes: z.number().int().min(2).max(12).default(2),
  isGuest: z.boolean().default(false),
  theme: z.string().default("system"),
  weightUnit: z.enum(["g", "oz"]).default("g"),
});

export const updateEventSchema = z.object({
  name: z.string().min(2).optional(),
  pointLimit: z.number().int().min(1).max(200).optional(),
  lanes: z.number().int().min(2).max(12).optional(),
  setupComplete: z.boolean().optional(),
  theme: z.string().optional(),
  weightUnit: z.enum(["g", "oz"]).optional(),
});

export const addScoutSchema = z.object({
  name: z.string().min(1),
  groupName: z.string().trim().min(1).max(50).optional(),
  weight: z.number().positive().max(10_000).optional(),
  pointsPenalty: z.number().int().min(0).max(200).optional(),
});

export const racePatrolRacerSchema = z.object({
  name: z.string().min(1),
  groupName: z.string().trim().min(1).max(50).optional(),
  weight: z.number().positive().max(10_000).optional(),
});

export const createRacePatrolSchema = z.object({
  name: z.string().trim().min(1).max(80),
  racers: z.array(racePatrolRacerSchema).min(1).max(300),
});

export const updateRacePatrolSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  racers: z.array(racePatrolRacerSchema).min(1).max(300).optional(),
});

export const importPatrolsSchema = z.object({
  patrolIds: z.array(z.string().min(1)).min(1).max(50),
});

export const postResultSchema = z.object({
  finishOrder: z.array(z.string().min(1)).min(2),
});

export const popularVoteSchema = z.object({
  favoriteScoutId: z.string().min(1),
});
