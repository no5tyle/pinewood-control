import { describe, expect, it } from "vitest";
import { COGNITO_ADDRESS, leaderUnits, planResync, racersFromMembers, TerrainLoginError, TerrainSession, unitLabel } from "./terrain";

describe("leaderUnits", () => {
  it("lists only the units the member leads, once each", () => {
    const units = leaderUnits([
      { member: { id: "m", name: "Sam" }, unit: { id: "u1", name: "Cub Unit", section: "cub", roles: ["unit-member", "unit-write"] }, group: { id: "g", name: "1st Wattle Creek" } },
      { member: { id: "m", name: "Sam" }, unit: { id: "u1", name: "Cub Unit", section: "cub", roles: ["unit-write"] } },
      { member: { id: "m", name: "Sam" }, unit: { id: "u2", name: "Scout Unit", section: "scout", roles: ["unit-member"] } },
      { member: { id: "m", name: "Sam" } },
    ]);
    expect(units).toEqual([{ id: "u1", name: "Cub Unit", groupName: "1st Wattle Creek", section: "cub" }]);
    expect(unitLabel(units[0])).toBe("Cubs, 1st Wattle Creek");
  });
});

describe("racersFromMembers", () => {
  const members = [
    { id: "1", first_name: "Liam", last_name: "Smith", unit: { duty: "member" }, patrol: { name: "Possum" } },
    { id: "2", first_name: "Ava", last_name: "Nguyen ", unit: { duty: "member" }, patrol: null },
    { id: "3", first_name: "Sam", last_name: "Leader", unit: { duty: "adult_leader" } },
  ];

  it("turns the youth into racers with their patrol as the group, leaving leaders out", () => {
    expect(racersFromMembers(members)).toEqual([{ name: "Ava Nguyen" }, { name: "Liam Smith", groupName: "Possum" }]);
  });

  it("adds the leaders, as their own group, when asked", () => {
    expect(racersFromMembers(members, { includeLeaders: true })).toContainEqual({ name: "Sam Leader", groupName: "Leaders" });
  });
});

describe("TerrainSession", () => {
  it("tries each login app until one accepts, then reads with the id token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let attempts = 0;
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === COGNITO_ADDRESS) {
        attempts++;
        const body = attempts < 3 ? { __type: "UserNotFoundException", message: "User does not exist." } : { AuthenticationResult: { IdToken: "id-token" } };
        return new Response(JSON.stringify(body), { status: attempts < 3 ? 400 : 200 });
      }
      return new Response(JSON.stringify({ results: [{ id: "1", first_name: "Ava", last_name: "Nguyen" }] }));
    }) as typeof fetch;
    const session = await TerrainSession.login("SA", " 1234567 ", "secret", fake);
    expect(JSON.parse(String(calls[0].init?.body)).AuthParameters.USERNAME).toBe("sa-1234567");
    expect(attempts).toBe(3);
    const members = await session.members("unit 1");
    expect(calls.at(-1)?.url).toBe("https://members.terrain.scouts.com.au/units/unit%201/members");
    expect((calls.at(-1)?.init?.headers as Record<string, string>).authorization).toBe("id-token");
    expect(members).toHaveLength(1);
  });

  it("reads with the browser's own fetch, which can't be called as a method", async () => {
    const strict = function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify(url.startsWith(COGNITO_ADDRESS) ? { AuthenticationResult: { IdToken: "t" } } : { results: [] })));
    } as unknown as typeof fetch;
    const session = await TerrainSession.login("sa", "1", "p", strict);
    await expect(session.members("u")).resolves.toEqual([]);
  });

  it("says so when no login app accepts the password", async () => {
    const fake = (async () => new Response(JSON.stringify({ __type: "NotAuthorizedException", message: "Incorrect username or password." }), { status: 400 })) as typeof fetch;
    await expect(TerrainSession.login("sa", "1", "wrong", fake)).rejects.toThrow(TerrainLoginError);
    await expect(TerrainSession.login("sa", "1", "wrong", fake)).rejects.toThrow("didn't accept that member number and password");
  });
});

describe("planResync", () => {
  const link = (scope: "unit" | "patrol" | "unpatrolled", patrol: string | null = null) => ({ unitId: "cubs", unitName: "Cubs, 1st Wattle Creek", scope, patrol, includeLeaders: false });
  const members = [
    { id: "1", first_name: "Ava", last_name: "Nguyen", unit: { duty: "member" }, patrol: { name: "Red Six" } },
    { id: "2", first_name: "Liam", last_name: "Smith", unit: { duty: "member" }, patrol: { name: "Red Six" } },
    { id: "3", first_name: "Zoe", last_name: "Taylor", unit: { duty: "member" }, patrol: { name: "Green Six" } },
    { id: "4", first_name: "Leo", last_name: "Wilson", unit: { duty: "member" }, patrol: null },
  ];
  const patrol = (id: string, terrain: ReturnType<typeof link>, names: string[]) => ({
    id, name: id, createdAt: 0, source: "terrain" as const, terrain,
    racers: names.map((name, i) => ({ id: `${id}${i}`, name, groupName: null, weight: name === "Ava Nguyen" ? 141 : null })),
  });

  it("finds who joined and left each Terrain patrol, keeping weights", () => {
    const plan = planResync([patrol("Red Six", link("patrol", "Red Six"), ["Ava Nguyen", "Mia Brown"])], "cubs", members);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].added).toEqual(["Liam Smith"]);
    expect(plan.updates[0].removed).toEqual(["Mia Brown"]);
    expect(plan.updates[0].racers).toContainEqual({ name: "Ava Nguyen", groupName: "Red Six", weight: 141 });
  });

  it("offers Terrain patrols a split import doesn't have yet, and leaves emptied ones alone", () => {
    const plan = planResync(
      [patrol("Red Six", link("patrol", "Red Six"), ["Ava Nguyen"]), patrol("Blue Six", link("patrol", "Blue Six"), ["Noah Jones"]), patrol("Others", link("unpatrolled"), ["Leo Wilson"])],
      "cubs",
      members,
    );
    expect(plan.emptied.map((p) => p.name)).toEqual(["Blue Six"]);
    expect(plan.newPatrols.map((p) => [p.name, p.racers.map((r) => r.name)])).toEqual([["Green Six", ["Zoe Taylor"]]]);
    expect(plan.updates.find((u) => u.patrol.name === "Others")?.racers.map((r) => r.name)).toEqual(["Leo Wilson"]);
  });

  it("refreshes a whole-unit patrol with everyone, and offers nothing new", () => {
    const plan = planResync([patrol("Cubs", link("unit"), ["Ava Nguyen"])], "cubs", members);
    expect(plan.updates[0].racers).toHaveLength(4);
    expect(plan.newPatrols).toEqual([]);
  });
});
