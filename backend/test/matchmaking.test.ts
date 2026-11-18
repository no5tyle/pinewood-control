import { describe, expect, it } from "vitest";
import { chooseNextHeat } from "../src/server/matchmaking.js";
import { newEvent } from "../src/server/eventService.js";
import type { EventDoc, ScoutDoc } from "../src/server/store/types.js";

function eventWith(count: number, lanes: number): EventDoc {
  const event = newEvent("e1", { name: "Test", pointLimit: 3, lanes, theme: "system", weightUnit: "g", isGuest: true, userId: null });
  for (let i = 1; i <= count; i += 1) {
    const scout: ScoutDoc = {
      id: `s${i}`, name: `Racer ${i}`, carNumber: String(i), groupName: null, weight: null, points: 0, eliminated: false,
      eliminatedAt: null, eliminatedHeatId: null, dropped: false, droppedAt: null, sourcePatrolRacerId: null,
      laneHistory: [], heatCountOffset: 0,
    };
    event.scouts.push(scout);
  }
  return event;
}

describe("matchmaking", () => {
  it("fills the lanes with racers who haven't raced yet", () => {
    const event = eventWith(6, 4);
    const lanes = chooseNextHeat(event)!;
    expect(new Set(lanes).size).toBe(lanes.length);
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(lanes.length).toBeLessThanOrEqual(4);
  });

  it("gives everyone a race before anyone races twice", () => {
    const event = eventWith(7, 3);
    const raced = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const lanes = chooseNextHeat(event)!;
      lanes.forEach((id, i) => {
        expect(raced.has(id)).toBe(false);
        raced.add(id);
        event.scouts.find((s) => s.id === id)!.laneHistory.push(i + 1);
      });
      event.heats.push({ id: `h${round}`, laneAssignments: lanes, finishOrder: lanes, loserScoutIds: [], laneTimes: {}, winnerScoutId: lanes[0], createdAt: round });
    }
    expect(raced.size).toBe(7);
  });

  it("needs two racers", () => {
    expect(chooseNextHeat(eventWith(1, 4))).toBeNull();
  });
});
