import { describe, expect, it } from "vitest";
import { parseCsv, planPatrols, racersFromCsv } from "./racerImport";

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes and any line ending", () => {
    expect(parseCsv('Name,Group\r\n"Smith, Liam","The ""Possums"""\nAva,Kookaburra\rNoah,')).toEqual([
      ["Name", "Group"],
      ["Smith, Liam", 'The "Possums"'],
      ["Ava", "Kookaburra"],
      ["Noah", ""],
    ]);
  });

  it("reads semicolons (Excel in some regions) and tabs, and skips blank lines and a byte order mark", () => {
    expect(parseCsv("﻿Name;Group\n\nAva;Kookaburra\n")).toEqual([["Name", "Group"], ["Ava", "Kookaburra"]]);
    expect(parseCsv("Name\tGroup\nAva\tKookaburra")).toEqual([["Name", "Group"], ["Ava", "Kookaburra"]]);
  });
});

describe("racersFromCsv", () => {
  it("finds the columns by their headings, in any order", () => {
    const { racers, skipped } = racersFromCsv("Weight (g),Patrol,Racer name\n141.5,Kookaburra,Ava Nguyen\n,Possum,Liam Smith\n");
    expect(racers).toEqual([
      { name: "Ava Nguyen", groupName: "Kookaburra", weight: 141.5 },
      { name: "Liam Smith", groupName: "Possum" },
    ]);
    expect(skipped).toEqual([]);
  });

  it("joins first and last names, as Terrain and most spreadsheets export them", () => {
    expect(racersFromCsv("First name,Last name,Six\nAva,Nguyen,Red\n").racers).toEqual([{ name: "Ava Nguyen", groupName: "Red" }]);
  });

  it("takes name, group, weight in that order when there are no headings", () => {
    expect(racersFromCsv("Ava Nguyen,Kookaburra,141\nLiam Smith").racers).toEqual([
      { name: "Ava Nguyen", groupName: "Kookaburra", weight: 141 },
      { name: "Liam Smith" },
    ]);
  });

  it("skips rows without a name and says why, and leaves a bad weight blank", () => {
    const { racers, skipped } = racersFromCsv("Name,Group,Weight\n,Possum,\nMia,Possum,heavy\n");
    expect(racers).toEqual([{ name: "Mia", groupName: "Possum" }]);
    expect(skipped).toEqual(["Row 2: no name", 'Row 3: weight "heavy" isn\'t a number, left blank']);
  });

  it("reads a decimal comma", () => {
    expect(racersFromCsv("Name;Weight\nAva;141,5").racers).toEqual([{ name: "Ava", weight: 141.5 }]);
  });
});

describe("planPatrols", () => {
  const racers = [
    { name: "Noah", groupName: "Kookaburra" },
    { name: "Ava", groupName: "Kookaburra" },
    { name: "Liam", groupName: "Possum" },
    { name: "Zoe" },
  ];

  it("puts everyone in one patrol, named as given", () => {
    const plan = planPatrols(racers, { split: false, name: "Cubs 2026", existing: [] });
    expect(plan.map((p) => [p.name, p.racers.map((r) => r.name)])).toEqual([["Cubs 2026", ["Ava", "Liam", "Noah", "Zoe"]]]);
  });

  it("makes one patrol per group, with the ungrouped last", () => {
    const plan = planPatrols(racers, { split: true, name: "Cubs 2026", existing: [] });
    expect(plan.map((p) => [p.name, p.racers.length])).toEqual([["Kookaburra", 2], ["Possum", 1], ["Cubs 2026", 1]]);
  });

  it("updates a patrol that already has the name, ignoring case", () => {
    const plan = planPatrols(racers, { split: true, name: "x", existing: [{ id: "p1", name: "possum " }] });
    expect(plan.find((p) => p.name === "Possum")?.existingId).toBe("p1");
    expect(plan.find((p) => p.name === "Kookaburra")?.existingId).toBeUndefined();
  });
});
