import { describe, expect, it } from "vitest";
import { armCommands, finishOrderFromTimes, LineBuffer, parseLine } from "./pdt";

describe("parseLine", () => {
  it("reads the single-character messages", () => {
    expect(parseLine("P")).toEqual({ kind: "power" });
    expect(parseLine("K\r")).toEqual({ kind: "ready" });
    expect(parseLine("O")).toEqual({ kind: "gateOpen" });
    expect(parseLine("B")).toEqual({ kind: "start" });
    expect(parseLine(".")).toEqual({ kind: "ack" });
    expect(parseLine("#next")).toEqual({ kind: "next" });
  });

  it("reads lane results, with 99.9990 as no time", () => {
    expect(parseLine("1 - 2.8734")).toEqual({ kind: "result", lane: 1, seconds: 2.8734 });
    expect(parseLine("3 - 99.9990")).toEqual({ kind: "result", lane: 3, seconds: null });
  });

  it("reads the version and lane count, and passes other lines through", () => {
    expect(parseLine("vert=3.40")).toEqual({ kind: "version", version: "3.40" });
    expect(parseLine("numl=4")).toEqual({ kind: "lanes", lanes: 4 });
    expect(parseLine(" pinewood-time race timer")).toEqual({ kind: "text", text: " pinewood-time race timer" });
    expect(parseLine("   ")).toBeNull();
  });
});

describe("LineBuffer", () => {
  it("joins lines split across reads", () => {
    const b = new LineBuffer();
    expect(b.push("1 - 2.87")).toEqual([]);
    expect(b.push("34\r\n2 - 2.9105\r\nB")).toEqual(["1 - 2.8734", "2 - 2.9105"]);
    expect(b.push("\r\n")).toEqual(["B"]);
  });
});

describe("finishOrderFromTimes", () => {
  it("orders racers fastest first", () => {
    const t = finishOrderFromTimes(["a", "b", "c"], new Map([[1, 2.95], [2, 2.81], [3, 3.1], [4, null]]));
    expect(t.finishOrder).toEqual(["b", "a", "c"]);
    expect(t.tiedPlaces).toEqual([]);
    expect(t.missingLanes).toEqual([]);
  });

  it("puts racers with no time last, in lane order, and reports them", () => {
    const t = finishOrderFromTimes(["a", "b", "c"], new Map([[1, null], [2, 2.81], [3, null]]));
    expect(t.finishOrder).toEqual(["b", "a", "c"]);
    expect(t.missingLanes).toEqual([1, 3]);
  });

  it("flags ties to the timer's 0.0001 s", () => {
    const t = finishOrderFromTimes(["a", "b", "c"], new Map([[1, 2.8734], [2, 2.8734], [3, 2.9]]));
    expect(t.finishOrder).toEqual(["a", "b", "c"]);
    expect(t.tiedPlaces).toEqual([2]);
  });

  it("skips empty lanes", () => {
    const t = finishOrderFromTimes(["a", "", "c"], new Map([[1, 3.0], [2, 2.5], [3, 2.9]]));
    expect(t.finishOrder).toEqual(["c", "a"]);
  });
});

describe("armCommands", () => {
  it("masks the lanes nobody is in, then resets", () => {
    expect(armCommands(["a", "b"], 4)).toEqual(["U", "M3", "M4", "R"]);
    expect(armCommands(["a", "b", "c"], 3)).toEqual(["U", "R"]);
  });
});
