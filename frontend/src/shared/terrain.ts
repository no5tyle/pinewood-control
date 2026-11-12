/*
  Reading a unit's members from Terrain (Scouts Australia's member system), for Race Patrols.

  The browser talks to Terrain directly with the leader's own login, as Beacon does: Pinewood Control's
  server never sees the password or Terrain's tokens. The token is held in memory for the import only
  and dropped when the dialog closes. Only names and patrols are read; nothing is written to Terrain.

  The requests are the ones Terrain's own app makes (see Beacon's src/lib/terrain/client.ts).
*/
import type { ImportedRacer } from "./racerImport";
import type { RacePatrol, TerrainLink } from "./types";

export const COGNITO_ADDRESS = "https://cognito-idp.ap-southeast-2.amazonaws.com/";
export const MEMBERS_ADDRESS = "https://members.terrain.scouts.com.au/";

/** Terrain's login app ids. Members belong to one of them, so login tries each in turn */
const CLIENT_IDS = [
  "6v98tbc09aqfvh52fml3usas3c",
  "5g9rg6ppc5g1pcs5odb7nf7hf9",
  "1u4uajve0lin0ki5n6b61ovva7",
  "21m9o832lp5krto1e8ioo6ldg2",
];

export const BRANCHES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];

const ACCEPT = "application/json, text/plain, */*";

interface ProfileRef {
  id: string;
  name: string;
  roles?: string[];
}

export interface TerrainProfile {
  member: ProfileRef;
  unit?: ProfileRef & { section?: string };
  group?: ProfileRef;
}

export interface TerrainMember {
  id: string;
  first_name: string;
  last_name: string;
  status?: string;
  unit?: { duty?: string };
  patrol?: { name?: string } | null;
}

export interface TerrainUnit {
  id: string;
  name: string;
  groupName: string;
  section: string;
}

export class TerrainLoginError extends Error {}

/** A unit the member leads: Terrain gives a leader's unit "unit-write", which youth never have */
export function leaderUnits(profiles: TerrainProfile[]): TerrainUnit[] {
  const seen = new Set<string>();
  const units: TerrainUnit[] = [];
  for (const p of profiles) {
    if (!p.unit || seen.has(p.unit.id) || !(p.unit.roles ?? []).includes("unit-write")) continue;
    seen.add(p.unit.id);
    units.push({ id: p.unit.id, name: p.unit.name, groupName: p.group?.name ?? "", section: p.unit.section ?? "" });
  }
  return units;
}

const SECTIONS: Record<string, string> = { joey: "Joeys", cub: "Cubs", scout: "Scouts", venturer: "Venturers", rover: "Rovers" };

/** e.g. "Cubs, 1st Wattle Creek" */
export function unitLabel(unit: TerrainUnit): string {
  const section = SECTIONS[unit.section] ?? unit.name;
  return unit.groupName ? `${section}, ${unit.groupName}` : section;
}

/** The unit's youth as racers, with their Terrain patrol as the group; adult leaders only when asked */
export function racersFromMembers(members: TerrainMember[], options: { includeLeaders?: boolean } = {}): ImportedRacer[] {
  return members
    .filter((m) => options.includeLeaders || m.unit?.duty !== "adult_leader")
    .map((m) => {
      const racer: ImportedRacer = { name: [m.first_name, m.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") };
      const patrol = (m.patrol?.name ?? "").trim();
      if (patrol) racer.groupName = patrol.slice(0, 50);
      else if (m.unit?.duty === "adult_leader") racer.groupName = "Leaders";
      return racer;
    })
    .filter((r) => r.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A signed in Terrain login, for reading only. Kept in memory; drop it to sign out */
export class TerrainSession {
  private readonly idToken: string;
  private readonly fetcher: typeof fetch;

  private constructor(idToken: string, fetcher: typeof fetch) {
    this.idToken = idToken;
    // Called through a wrapper: the browser's fetch fails ("Illegal invocation") when called as a method
    this.fetcher = (input, init) => fetcher(input, init);
  }

  /** Logs in with a branch (e.g. "sa"), member number and password */
  static async login(branch: string, memberNumber: string, password: string, fetcher: typeof fetch = fetch): Promise<TerrainSession> {
    let message = "";
    for (const clientId of CLIENT_IDS) {
      let body: Record<string, unknown> | null = null;
      try {
        const response = await fetcher(COGNITO_ADDRESS, {
          method: "POST",
          headers: {
            "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
            "Content-Type": "application/x-amz-json-1.1",
            accept: ACCEPT,
          },
          body: JSON.stringify({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: clientId,
            AuthParameters: { USERNAME: `${branch.toLowerCase()}-${memberNumber.trim()}`, PASSWORD: password, DEVICE_KEY: null, REFRESH_TOKEN: null },
            ClientMetadata: {},
          }),
        });
        body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      } catch {
        throw new TerrainLoginError("Couldn't reach Terrain. Check the connection and try again.");
      }
      const tokens = body?.AuthenticationResult as { IdToken?: string } | undefined;
      if (tokens?.IdToken) return new TerrainSession(tokens.IdToken, fetcher);
      message = String(body?.message ?? "");
    }
    throw new TerrainLoginError(
      /incorrect username or password/i.test(message) || !message
        ? "Terrain didn't accept that member number and password."
        : `Terrain didn't accept the login: ${message}`,
    );
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${MEMBERS_ADDRESS}${path}`, { headers: { authorization: this.idToken, accept: ACCEPT }, cache: "no-store" });
    } catch {
      throw new Error("Couldn't reach Terrain. Check the connection and try again.");
    }
    if (!response.ok) throw new Error(`Terrain couldn't load this (response ${response.status}).`);
    return (await response.json()) as T;
  }

  /** The units this member leads */
  async units(): Promise<TerrainUnit[]> {
    const result = await this.get<{ profiles?: TerrainProfile[] }>("profiles");
    return leaderUnits(result.profiles ?? []);
  }

  async members(unitId: string): Promise<TerrainMember[]> {
    const result = await this.get<{ results?: TerrainMember[] }>(`units/${encodeURIComponent(unitId)}/members`);
    return result.results ?? [];
  }
}

/** The racers a Terrain-linked patrol holds now, from its unit's current members */
export function racersForLink(members: TerrainMember[], link: TerrainLink): ImportedRacer[] {
  const racers = racersFromMembers(members, { includeLeaders: link.includeLeaders });
  if (link.scope === "unit") return racers;
  if (link.scope === "unpatrolled") return racers.filter((r) => !r.groupName);
  return racers.filter((r) => r.groupName === link.patrol);
}

export interface PatrolResync {
  patrol: RacePatrol;
  racers: ImportedRacer[];
  added: string[];
  removed: string[];
}

export interface ResyncPlan {
  /** Patrols with someone in them now, changed or not */
  updates: PatrolResync[];
  /** Patrols nobody in Terrain belongs to any more: left as they are */
  emptied: RacePatrol[];
  /** Terrain patrols in a unit imported a patrol at a time that have no Race Patrol yet */
  newPatrols: { link: TerrainLink; name: string; racers: ImportedRacer[] }[];
}

const lower = (s: string) => s.trim().toLowerCase();

/** What resyncing a unit's Terrain patrols would change, from the unit's current members */
export function planResync(patrols: RacePatrol[], unitId: string, members: TerrainMember[]): ResyncPlan {
  const linked = patrols.filter((p) => p.terrain?.unitId === unitId);
  const plan: ResyncPlan = { updates: [], emptied: [], newPatrols: [] };
  for (const patrol of linked) {
    const racers = racersForLink(members, patrol.terrain!);
    if (racers.length === 0) {
      plan.emptied.push(patrol);
      continue;
    }
    const before = new Set(patrol.racers.map((r) => lower(r.name)));
    const after = new Set(racers.map((r) => lower(r.name)));
    plan.updates.push({
      patrol,
      // Weights aren't in Terrain: keep the ones already entered
      racers: racers.map((r) => {
        const weight = patrol.racers.find((x) => lower(x.name) === lower(r.name))?.weight;
        return typeof weight === "number" ? { ...r, weight } : r;
      }),
      added: racers.filter((r) => !before.has(lower(r.name))).map((r) => r.name),
      removed: patrol.racers.filter((r) => !after.has(lower(r.name))).map((r) => r.name),
    });
  }
  // A unit imported a patrol at a time: any Terrain patrol it doesn't have yet is offered
  const split = linked.filter((p) => p.terrain!.scope !== "unit");
  if (split.length > 0) {
    const sample = split[0].terrain!;
    const covered = new Set(split.filter((p) => p.terrain!.scope === "patrol").map((p) => p.terrain!.patrol));
    const all = racersFromMembers(members, { includeLeaders: split.some((p) => p.terrain!.includeLeaders) });
    const groups = [...new Set(all.map((r) => r.groupName).filter((g): g is string => !!g && !covered.has(g)))].sort();
    for (const group of groups) {
      const link: TerrainLink = { unitId, unitName: sample.unitName, scope: "patrol", patrol: group, includeLeaders: sample.includeLeaders };
      plan.newPatrols.push({ link, name: group, racers: all.filter((r) => r.groupName === group) });
    }
  }
  return plan;
}
