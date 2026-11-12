import { describe, expect, it } from "vitest";
import { COGNITO_ADDRESS, leaderUnits, racersFromMembers, TerrainLoginError, TerrainSession, unitLabel } from "./terrain";

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
