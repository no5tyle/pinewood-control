/*
  Event helpers: the JSON the app sees, and the live updates.

  - serializeEvent turns a stored event into the shape the frontend expects.
  - changeEvent applies a change to an event atomically, keeps updatedAt current, and sends every
    subscribed screen the new event over Socket.IO.
*/
import type { Server } from "socket.io";
import { collections, HttpError, type Db } from "./store/db.js";
import type { EventDoc, ScoutDoc } from "./store/types.js";

export const GUEST_EVENT_TTL_MS = 24 * 60 * 60_000;

function compareCarNumbers(a: { carNumber: string }, b: { carNumber: string }): number {
  const aNum = Number.parseInt(String(a.carNumber ?? ""), 10);
  const bNum = Number.parseInt(String(b.carNumber ?? ""), 10);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
  return 0;
}

export function sortStandings<T extends ScoutDoc>(scouts: T[]): T[] {
  return [...scouts].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;

    if (!a.eliminated && !b.eliminated) {
      if (a.points !== b.points) return a.points - b.points;
      return compareCarNumbers(a, b) || String(a.name ?? "").localeCompare(String(b.name ?? ""));
    }

    const aElimAt = a.eliminatedAt ?? 0;
    const bElimAt = b.eliminatedAt ?? 0;
    if (aElimAt !== bElimAt) return bElimAt - aElimAt;
    if (a.points !== b.points) return a.points - b.points;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

/** Racers ranked by popular votes, most first, for once the vote has been revealed. */
export function rankByVotes<T extends ScoutDoc>(scouts: T[], counts: Map<string, number>) {
  return scouts
    .map((scout) => ({ scout, votes: counts.get(scout.id) ?? 0 }))
    .sort((a, b) => {
      if (a.votes !== b.votes) return b.votes - a.votes;
      return compareCarNumbers(a.scout, b.scout) || String(a.scout.name ?? "").localeCompare(String(b.scout.name ?? ""));
    });
}

export function currentHeat(event: EventDoc) {
  return event.heats.find((h) => h.finishOrder.length === 0) ?? null;
}

export function serializeEvent(event: EventDoc) {
  const scouts = event.scouts;
  const active = scouts.filter((s) => !s.eliminated);
  const finalWinner = event.setupComplete && active.length === 1 ? active[0] : null;
  const popularVoteWinner = event.popularVoteWinnerScoutId
    ? scouts.find((s) => s.id === event.popularVoteWinnerScoutId) ?? null
    : null;

  return {
    id: event.id,
    name: event.name,
    pointLimit: event.pointLimit,
    lanes: event.lanes,
    setupComplete: event.setupComplete,
    isGuest: Boolean(event.isGuest),
    theme: event.theme,
    weightUnit: event.weightUnit ?? "g",
    popularVoteRevealAt: event.popularVoteRevealAt ?? null,
    popularVoteRevealCountdownSeconds: 3,
    popularVoteWinnerScoutId: event.popularVoteWinnerScoutId ?? null,
    popularVoteWinner,
    createdAt: event.createdAt,
    lastUsedAt: event.updatedAt,
    completedAt: event.completedAt ?? null,
    scouts,
    heats: event.heats,
    standings: sortStandings(scouts),
    currentHeatId: currentHeat(event)?.id ?? null,
    championScoutId: finalWinner?.id ?? null,
    isComplete: Boolean(finalWinner),
  };
}

export function newEvent(
  id: string,
  fields: { name: string; pointLimit: number; lanes: number; theme: string; weightUnit: "g" | "oz"; isGuest: boolean; userId: string | null },
): EventDoc {
  const now = Date.now();
  return {
    id,
    ...fields,
    setupComplete: false,
    popularVoteRevealAt: null,
    popularVoteWinnerScoutId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    expireAt: fields.userId ? null : new Date(now + GUEST_EVENT_TTL_MS),
    scouts: [],
    heats: [],
    logs: [],
  };
}

/** Marks the event complete when one racer is left. */
export function settleCompletion(event: EventDoc) {
  if (!event.completedAt && event.scouts.filter((s) => !s.eliminated).length === 1) event.completedAt = Date.now();
}

export async function loadEvent(db: Db, eventId: string): Promise<EventDoc> {
  const event = await db.get<EventDoc>(collections.events, eventId);
  if (!event) throw new HttpError(404, "Event not found");
  return event;
}

export function publish(io: Server, event: EventDoc) {
  noteActivity(event.id);
  io.to(event.id).emit("event:update", serializeEvent(event));
}

/** When each event last changed, for closing connections that have nothing to follow (socketHandlers.ts). */
export const lastActivity = new Map<string, number>();
export function noteActivity(eventId: string) {
  lastActivity.set(eventId, Date.now());
}

/**
 * Changes an event atomically and tells everyone watching it. `change` edits the event in place (it may
 * run more than once, so it mustn't do anything else) and can throw an HttpError to refuse.
 */
export async function changeEvent(
  db: Db,
  io: Server,
  eventId: string,
  change: (event: EventDoc) => void,
  options: { touch?: boolean } = {},
): Promise<EventDoc> {
  const updated = await db.update<EventDoc>(collections.events, eventId, (current) => {
    if (!current) throw new HttpError(404, "Event not found");
    change(current);
    if (options.touch !== false) current.updatedAt = Date.now();
    return current;
  });
  publish(io, updated!);
  return updated!;
}
