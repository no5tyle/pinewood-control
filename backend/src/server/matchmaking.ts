/*
  Heat matchmaking algorithm.

  Usage:
  - chooseNextHeat(prisma, eventId) is called by the “generate heat” route.
  - It selects the next group and lane ordering based on:
    1) balancing heats participated (nobody races twice before others race once, where possible)
    2) maximizing new opponent pairings / minimizing repeat matchups
    3) lane fairness (even lane usage over time)
    4) points closeness as a final tie-breaker
  - It persists laneHistory updates and creates the Heat record.
*/
import type { PrismaClient } from "@prisma/client";
import { nanoid } from "nanoid";
import { getEventWithDetails } from "./eventService.js";
import { safeParseJSON, shuffle } from "./helpers.js";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function buildPairCounts(prisma: PrismaClient, eventId: string): Promise<Map<string, number>> {
  const heats = await prisma.heat.findMany({
    where: { eventId },
    select: { laneAssignments: true },
  });

  const counts = new Map<string, number>();
  for (const heat of heats) {
    const laneAssignments = safeParseJSON<string[]>(heat.laneAssignments, []);
    for (let i = 0; i < laneAssignments.length; i += 1) {
      for (let j = i + 1; j < laneAssignments.length; j += 1) {
        const key = pairKey(laneAssignments[i], laneAssignments[j]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function getPermutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of getPermutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

function getPermutationCandidates<T extends { id?: string }>(items: T[]): T[][] {
  if (items.length <= 6) return getPermutations(items);

  const target = 2000;
  const out: T[][] = [];
  const seen = new Set<string>();

  const keyOf = (perm: T[]) => perm.map((x) => x.id ?? "").join("|");
  const localShuffle = (arr: T[]) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const firstKey = keyOf(items);
  if (firstKey.length > 0) {
    seen.add(firstKey);
    out.push(items);
  }

  let tries = 0;
  while (out.length < target && tries < target * 8) {
    tries += 1;
    const perm = localShuffle(items);
    const key = keyOf(perm);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(perm);
  }

  return out.length > 0 ? out : [items];
}

function buildCandidateGroups(active: any[], heatSize: number): any[][] {
  if (active.length < heatSize) return [];
  if (active.length === heatSize) return [active];

  const sorted = [...active].sort((a, b) => {
    if (a.points !== b.points) return a.points - b.points;
    const aNum = Number.parseInt(String(a.carNumber ?? ""), 10);
    const bNum = Number.parseInt(String(b.carNumber ?? ""), 10);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
    return a.name.localeCompare(b.name);
  });

  const groups: any[][] = [];
  const seen = new Set<string>();

  for (let start = 0; start <= sorted.length - heatSize; start += 1) {
    const window = sorted.slice(start, start + heatSize);
    const key = window.map((s) => s.id).sort().join(",");
    if (!seen.has(key)) {
      seen.add(key);
      groups.push(window);
    }
  }

  return groups;
}

function laneBalanceScore(scout: any, lane: number): number {
  const history = safeParseJSON<number[]>(scout.laneHistory, []);
  return history.filter((l) => l === lane).length;
}

function heatsRunCount(scout: any): number {
  return safeParseJSON<number[]>(scout.laneHistory, []).length;
}

function compareScoutsForSelection(a: any, b: any): number {
  const aRuns = heatsRunCount(a);
  const bRuns = heatsRunCount(b);
  if (aRuns !== bRuns) return aRuns - bRuns;
  if (a.points !== b.points) return a.points - b.points;
  const aNum = Number.parseInt(String(a.carNumber ?? ""), 10);
  const bNum = Number.parseInt(String(b.carNumber ?? ""), 10);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""));
}

function sampleUniqueGroups(pool: any[], size: number, target: number): any[][] {
  if (size <= 0) return [];
  if (size === 1) return pool.slice(0, Math.max(0, target)).map((s) => [s]);
  if (pool.length < size) return [];
  if (pool.length === size) return [pool];

  const out: any[][] = [];
  const seen = new Set<string>();

  const keyOf = (items: any[]) => items.map((s) => s.id).sort().join(",");

  const baseline = [...pool].sort(compareScoutsForSelection).slice(0, size);
  seen.add(keyOf(baseline));
  out.push(baseline);

  let tries = 0;
  while (out.length < target && tries < target * 15) {
    tries += 1;
    const picked = shuffle(pool).slice(0, size);
    const key = keyOf(picked);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(picked);
  }

  return out;
}

function chooseDesiredHeatSize(minBucketSize: number, lanes: number): number {
  const laneMax = Math.max(2, lanes);
  if (minBucketSize <= 1) return 2;
  if (minBucketSize <= laneMax) return minBucketSize;
  const heatsNeeded = Math.ceil(minBucketSize / laneMax);
  const balancedSize = Math.ceil(minBucketSize / heatsNeeded);
  return Math.min(laneMax, Math.max(2, balancedSize));
}

export async function chooseNextHeat(prisma: PrismaClient, eventId: string): Promise<any | null> {
  const event = await getEventWithDetails(prisma, eventId);
  const active = event.scouts.filter((s: any) => !s.eliminated);
  if (active.length < 2) return null;

  const laneMax = Math.min(Math.max(event.lanes, 2), active.length);
  if (laneMax < 2) return null;

  const runsById = new Map<string, number>(active.map((s: any) => [s.id as string, heatsRunCount(s)]));
  const minRuns = Math.min(...Array.from(runsById.values()));
  const minBucket = active.filter((s: any) => (runsById.get(s.id) ?? 0) === minRuns);
  const desiredHeatSize = Math.min(laneMax, chooseDesiredHeatSize(minBucket.length, laneMax));

  const pairCounts = await buildPairCounts(prisma, eventId);
  let candidateGroups: any[][] = (() => {
    if (minBucket.length >= desiredHeatSize) {
      return sampleUniqueGroups(minBucket, desiredHeatSize, 140);
    }

    const fixed = [...minBucket].sort(compareScoutsForSelection);
    const remainingSlots = Math.max(0, desiredHeatSize - fixed.length);
    const others = active
      .filter((s: any) => !fixed.some((m: any) => m.id === s.id))
      .sort(compareScoutsForSelection);
    const fillPoolSize = Math.min(others.length, Math.max(remainingSlots * 4, 12));
    const fillPool = others.slice(0, fillPoolSize);
    const fillGroups = remainingSlots === 0 ? [[]] : sampleUniqueGroups(fillPool, remainingSlots, 140);
    return fillGroups.map((g) => [...fixed, ...g]);
  })();

  if (candidateGroups.length === 0) {
    candidateGroups = buildCandidateGroups(active, desiredHeatSize);
  }

  let bestLaneAssignments: string[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const group of candidateGroups) {
    const lanePermutations = getPermutationCandidates(group);
    let bestGroupAssignment: any[] | null = null;
    let bestGroupLaneCost = Number.POSITIVE_INFINITY;

    for (const perm of lanePermutations) {
      const laneCost = perm.reduce((sum: number, scout: any, index: number) => {
        const lane = index + 1;
        return sum + laneBalanceScore(scout, lane);
      }, 0);

      if (laneCost < bestGroupLaneCost) {
        bestGroupLaneCost = laneCost;
        bestGroupAssignment = perm;
      }
    }

    if (!bestGroupAssignment) continue;

    const afterRuns = new Map<string, number>(runsById);
    group.forEach((s: any) => afterRuns.set(s.id as string, (afterRuns.get(s.id as string) ?? 0) + 1));
    const afterValues = Array.from(afterRuns.values());
    const afterMin = Math.min(...afterValues);
    const afterMax = Math.max(...afterValues);
    const participationSpreadAfter = afterMax - afterMin;
    const participationTotalDeviation = afterValues.reduce((sum: number, v: number) => sum + (v - afterMin), 0);

    let repeats = 0;
    let newPairs = 0;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const count = pairCounts.get(pairKey(group[i].id, group[j].id)) ?? 0;
        repeats += count;
        if (count === 0) newPairs += 1;
      }
    }

    const points = group.map((s: any) => s.points);
    const minPoints = Math.min(...points);
    const maxPoints = Math.max(...points);
    const pointSpread = maxPoints - minPoints;
    const pointAvg = points.reduce((sum: number, p: number) => sum + p, 0) / points.length;
    const pointDeviation = points.reduce((sum: number, p: number) => sum + Math.abs(p - pointAvg), 0);

    const score =
      participationSpreadAfter * 1_000_000 +
      participationTotalDeviation * 80_000 +
      repeats * 9_000 +
      newPairs * -450 +
      bestGroupLaneCost * 400 +
      pointSpread * 70 +
      pointDeviation * 20;

    if (score < bestScore) {
      bestScore = score;
      bestLaneAssignments = bestGroupAssignment.map((s: any) => s.id);
    }
  }

  if (!bestLaneAssignments || bestLaneAssignments.length < 2) {
    const fallbackGroup = [...active].sort(compareScoutsForSelection).slice(0, laneMax);
    if (fallbackGroup.length < 2) return null;

    const lanePermutations = getPermutationCandidates(fallbackGroup);
    let bestFallbackAssignment: any[] | null = null;
    let bestFallbackLaneCost = Number.POSITIVE_INFINITY;

    for (const perm of lanePermutations) {
      const laneCost = perm.reduce((sum: number, scout: any, index: number) => {
        const lane = index + 1;
        return sum + laneBalanceScore(scout, lane);
      }, 0);
      if (laneCost < bestFallbackLaneCost) {
        bestFallbackLaneCost = laneCost;
        bestFallbackAssignment = perm;
      }
    }

    bestLaneAssignments = (bestFallbackAssignment ?? fallbackGroup).map((s: any) => s.id);
    if (bestLaneAssignments.length < 2) return null;
  }

  const laneAssignments = bestLaneAssignments;

  for (let i = 0; i < laneAssignments.length; i += 1) {
    const scout = event.scouts.find((s: any) => s.id === laneAssignments[i]);
    if (!scout) continue;
    const history = safeParseJSON<number[]>(scout.laneHistory, []);
    history.push(i + 1);
    await prisma.scout.update({
      where: { id: scout.id },
      data: { laneHistory: JSON.stringify(history) },
    });
  }

  return await prisma.heat.create({
    data: {
      id: nanoid(8),
      laneAssignments: JSON.stringify(laneAssignments),
      finishOrder: "[]",
      eventId,
    },
  });
}
