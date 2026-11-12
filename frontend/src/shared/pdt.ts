/*
  The PDT race timer's serial protocol, as spoken by David Gadberry's PDT and by pinewood-time
  (github.com/no5tyle/pinewood-time). Pure functions only: the serial port is in pdtSerial.ts.

  The timer sends one message per line:
    P            powered on, waiting for a reset
    K            ready: the race starts when the gate opens
    O            asked to get ready, but the start gate is open
    B            the gate opened: racing
    .            a command was done
    1 - 2.8734   a lane's time in seconds (99.9990 = no time); one line per lane once the race is over
    vert=3.40    protocol version (the V command)
    numl=4       lanes the timer is set up for (the N command)
    #next        pinewood-time only: its button asked for the next heat

  Commands are single characters: R (reset / get ready), U (unmask every lane), M then a lane digit (leave a
  lane out), N, V, I. pinewood-time also takes "#" settings lines.
*/

export type PdtMessage =
  | { kind: "power" }
  | { kind: "ready" }
  | { kind: "gateOpen" }
  | { kind: "start" }
  | { kind: "ack" }
  | { kind: "result"; lane: number; seconds: number | null }
  | { kind: "next" }
  | { kind: "version"; version: string }
  | { kind: "lanes"; lanes: number }
  | { kind: "text"; text: string };

/** At or above this a lane has no time (PDT sends 99.9990) */
export const NO_TIME_SECONDS = 99.9;

export function parseLine(raw: string): PdtMessage | null {
  const line = raw.replace(/[\r\n]+$/g, "");
  const trimmed = line.trim();
  if (!trimmed) return null;
  switch (trimmed) {
    case "P":
      return { kind: "power" };
    case "K":
      return { kind: "ready" };
    case "O":
      return { kind: "gateOpen" };
    case "B":
      return { kind: "start" };
    case ".":
      return { kind: "ack" };
    case "#next":
      return { kind: "next" };
  }
  const result = /^(\d{1,2})\s*-\s*(\d+(?:\.\d+)?)/.exec(trimmed);
  if (result) {
    const seconds = Number(result[2]);
    return { kind: "result", lane: Number(result[1]), seconds: Number.isFinite(seconds) && seconds < NO_TIME_SECONDS ? seconds : null };
  }
  const version = /^vert=(.+)$/i.exec(trimmed);
  if (version) return { kind: "version", version: version[1].trim() };
  const lanes = /^numl=(\d+)$/i.exec(trimmed);
  if (lanes) return { kind: "lanes", lanes: Number(lanes[1]) };
  return { kind: "text", text: line };
}

/** Splits incoming serial text into whole lines, keeping a partial line until the rest arrives */
export class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split(/\r?\n|\r/);
    this.pending = parts.pop() ?? "";
    return parts.filter((p) => p.length > 0);
  }
}

export type LaneTime = { scoutId: string; lane: number; seconds: number | null };

export type HeatTiming = {
  /** Scout ids, fastest first; racers with no time last, in lane order */
  finishOrder: string[];
  placings: LaneTime[];
  /** Places (1-based) that share a time with the racer before them: the operator should check them */
  tiedPlaces: number[];
  /** Lanes with a racer but no time */
  missingLanes: number[];
};

/**
 * The finish order for a heat from the timer's lane times. laneAssignments[i] is the racer in lane i + 1
 * (an empty string or missing entry for an empty lane). Times are compared to the timer's 0.0001 s.
 */
export function finishOrderFromTimes(laneAssignments: string[], times: Map<number, number | null>): HeatTiming {
  const entries: LaneTime[] = [];
  laneAssignments.forEach((scoutId, i) => {
    if (!scoutId) return;
    const t = times.get(i + 1);
    entries.push({ scoutId, lane: i + 1, seconds: t === undefined ? null : t });
  });
  const tenths = (s: number) => Math.round(s * 10000);
  const placings = [...entries].sort((a, b) => {
    if (a.seconds === null && b.seconds === null) return a.lane - b.lane;
    if (a.seconds === null) return 1;
    if (b.seconds === null) return -1;
    return tenths(a.seconds) - tenths(b.seconds) || a.lane - b.lane;
  });
  const tiedPlaces: number[] = [];
  for (let i = 1; i < placings.length; i++) {
    const a = placings[i - 1].seconds;
    const b = placings[i].seconds;
    if (a !== null && b !== null && tenths(a) === tenths(b)) tiedPlaces.push(i + 1);
  }
  return {
    finishOrder: placings.map((p) => p.scoutId),
    placings,
    tiedPlaces,
    missingLanes: placings.filter((p) => p.seconds === null).map((p) => p.lane),
  };
}

/**
 * The commands that get the timer ready for a heat: unmask every lane, mask the lanes with nobody in them
 * (so the race doesn't wait for them), then reset. timerLanes is how many lanes the timer is set up for.
 */
export function armCommands(laneAssignments: string[], timerLanes: number): string[] {
  const commands = ["U"];
  for (let lane = 1; lane <= Math.min(timerLanes, 9); lane++) {
    if (!laneAssignments[lane - 1]) commands.push(`M${lane}`);
  }
  commands.push("R");
  return commands;
}

/** "2.873" for a time on screen; "no time" when there isn't one */
export function formatSeconds(seconds: number | null): string {
  return seconds === null ? "no time" : `${seconds.toFixed(3)} s`;
}
