/*
  Event read/serialize/publish helpers.

  Usage:
  - getEventWithDetails loads the event with all related data needed for UI and calculations.
  - serializeEvent converts Prisma records into the JSON shape the frontend expects (timestamps as ms, JSON fields parsed).
  - publishEvent emits the serialized event to all connected Socket.IO subscribers for that eventId room.
*/
import type { PrismaClient } from "@prisma/client";
import type { Server } from "socket.io";
import { safeParseJSON } from "./helpers.js";

export async function getEventWithDetails(prisma: PrismaClient, eventId: string) {
  const event = await (prisma as any).event.findUnique({
    where: { id: eventId },
    include: {
      scouts: {
        include: { wonHeats: true },
      },
      heats: {
        orderBy: { createdAt: "asc" },
      },
      logs: {
        orderBy: { createdAt: "asc" },
      },
    } as any,
  });
  if (!event) throw new Error("Event not found");
  return event;
}

export function sortStandings(scouts: any[]): any[] {
  return [...scouts].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;

    if (!a.eliminated && !b.eliminated) {
      if (a.points !== b.points) return a.points - b.points;
      const aNum = Number.parseInt(String(a.carNumber ?? ""), 10);
      const bNum = Number.parseInt(String(b.carNumber ?? ""), 10);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
      return String(a.name ?? "").localeCompare(String(b.name ?? ""));
    }

    const aElimAt = a.eliminatedAt ? new Date(a.eliminatedAt).getTime() : 0;
    const bElimAt = b.eliminatedAt ? new Date(b.eliminatedAt).getTime() : 0;
    if (aElimAt !== bElimAt) return bElimAt - aElimAt;
    if (a.points !== b.points) return a.points - b.points;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

export function serializeEvent(event: any) {
  const scouts = event.scouts.map((s: any) => ({
    ...s,
    laneHistory: safeParseJSON<number[]>(s.laneHistory, []),
    eliminatedAt: s.eliminatedAt ? s.eliminatedAt.getTime() : null,
    eliminatedHeatId: s.eliminatedHeatId ?? null,
    droppedAt: s.droppedAt ? s.droppedAt.getTime() : null,
    sourcePatrolRacerId: s.sourcePatrolRacerId ?? null,
  }));

  const active = scouts.filter((s: any) => !s.eliminated);
  const finalWinner = event.setupComplete && active.length === 1 ? active[0] : null;
  const currentHeat = event.heats.find((h: any) => safeParseJSON<string[]>(h.finishOrder, []).length === 0);
  const popularVoteWinner = event.popularVoteWinnerScoutId
    ? scouts.find((s: any) => s.id === event.popularVoteWinnerScoutId) ?? null
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
    popularVoteRevealAt: event.popularVoteRevealAt?.getTime() ?? null,
    popularVoteRevealCountdownSeconds: 3,
    popularVoteWinnerScoutId: event.popularVoteWinnerScoutId ?? null,
    popularVoteWinner,
    createdAt: event.createdAt.getTime(),
    lastUsedAt: event.updatedAt.getTime(),
    completedAt: event.completedAt?.getTime() ?? null,
    scouts,
    heats: event.heats.map((h: any) => ({
      ...h,
      laneAssignments: safeParseJSON<string[]>(h.laneAssignments, []),
      finishOrder: safeParseJSON<string[]>(h.finishOrder, []),
      loserScoutIds: safeParseJSON<string[]>(h.loserScoutIds, []),
      createdAt: h.createdAt.getTime(),
    })),
    standings: sortStandings(scouts),
    currentHeatId: currentHeat?.id ?? null,
    championScoutId: finalWinner?.id ?? null,
    isComplete: Boolean(finalWinner),
  };
}

export async function touchEvent(prisma: PrismaClient, eventId: string) {
  await prisma.event.update({
    where: { id: eventId },
    data: { updatedAt: new Date() },
    select: { id: true },
  });
}

export async function publishEvent(io: Server, prisma: PrismaClient, eventId: string) {
  const event = await getEventWithDetails(prisma, eventId);
  io.to(eventId).emit("event:update", serializeEvent(event));
}
