import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harnesses, IDLE_CLOSE_MS, type Server } from "./harness.js";
import { collections } from "../src/server/store/db.js";
import type { EventDoc } from "../src/server/store/types.js";

for (const h of harnesses) {
  describe(`Pinewood API ${h.name}`, () => {
    let api: Server;
    beforeAll(async () => { api = await h.start(); });
    afterAll(async () => { await api.stop(); });

    const makeEvent = async (token?: string, extra: object = {}) => {
      const res = await api.call("POST", "/api/events", { token, body: { name: "Cub Derby", pointLimit: 2, lanes: 2, ...extra } });
      expect(res.status).toBe(201);
      return res.body;
    };
    const addRacers = async (eventId: string, names: string[], token?: string) => {
      for (const name of names) {
        expect((await api.call("POST", `/api/events/${eventId}/scouts`, { token, body: { name } })).status).toBe(201);
      }
    };

    it("answers health checks", async () => {
      expect((await api.call("GET", "/api/health")).body.ok).toBe(true);
    });

    it("runs a guest event to a champion", async () => {
      const event = await makeEvent();
      expect(event.isGuest).toBe(true);
      await addRacers(event.id, ["Ada", "Ben", "Cy"]);
      expect((await api.call("PATCH", `/api/events/${event.id}`, { body: { setupComplete: true } })).body.setupComplete).toBe(true);

      for (let i = 0; i < 20; i += 1) {
        const state = (await api.call("GET", `/api/events/${event.id}`)).body;
        if (state.isComplete) break;
        const heat = await api.call("POST", `/api/events/${event.id}/next-heat`);
        expect(heat.status).toBe(201);
        expect(heat.body.laneAssignments.length).toBe(2);
        expect((await api.call("POST", `/api/events/${event.id}/next-heat`)).status).toBe(400);
        const result = await api.call("POST", `/api/events/${event.id}/heats/${heat.body.id}/result`, {
          body: { finishOrder: heat.body.laneAssignments, laneTimes: { [heat.body.laneAssignments[0]]: 3.1, stranger: 9 } },
        });
        expect(result.status).toBe(200);
      }

      const done = (await api.call("GET", `/api/events/${event.id}`)).body;
      expect(done.isComplete).toBe(true);
      expect(done.completedAt).toBeTypeOf("number");
      expect(done.standings[0].id).toBe(done.championScoutId);
      expect(Object.keys(done.heats[0].laneTimes)).toEqual([done.heats[0].laneAssignments[0]]);
      expect((await api.call("POST", `/api/events/${event.id}/next-heat`)).status).toBe(400);

      const results = (await api.call("GET", `/api/events/${event.id}/results`)).body;
      expect(results.champion.id).toBe(done.championScoutId);
      expect(results.heatResults.length).toBe(done.heats.length);
    });

    it("checks heat results", async () => {
      const event = await makeEvent();
      await addRacers(event.id, ["Ada", "Ben"]);
      const heat = (await api.call("POST", `/api/events/${event.id}/next-heat`)).body;
      const post = (finishOrder: string[]) => api.call("POST", `/api/events/${event.id}/heats/${heat.id}/result`, { body: { finishOrder } });
      expect((await post([heat.laneAssignments[0], heat.laneAssignments[0]])).status).toBe(400);
      expect((await post([heat.laneAssignments[0], "nobody"])).status).toBe(400);
      expect((await post(heat.laneAssignments)).status).toBe(200);
      expect((await post(heat.laneAssignments)).body.message).toBe("Result already posted");
      expect((await api.call("POST", `/api/events/${event.id}/heats/nope/result`, { body: { finishOrder: ["a", "b"] } })).status).toBe(404);
    });

    it("adds late entrants and drops racers", async () => {
      const event = await makeEvent(undefined, { pointLimit: 5 });
      await addRacers(event.id, ["Ada", "Ben", "Cy"]);
      const heat = (await api.call("POST", `/api/events/${event.id}/next-heat`)).body;
      const inHeat = heat.laneAssignments[0];
      expect((await api.call("POST", `/api/events/${event.id}/scouts/${inHeat}/drop`)).status).toBe(400);
      expect((await api.call("DELETE", `/api/events/${event.id}/scouts/${inHeat}`)).status).toBe(400);
      await api.call("POST", `/api/events/${event.id}/heats/${heat.id}/result`, { body: { finishOrder: heat.laneAssignments } });

      const late = await api.call("POST", `/api/events/${event.id}/scouts`, { body: { name: "Dee", pointsPenalty: 1 } });
      expect(late.body.carNumber).toBe("4");
      expect(late.body.points).toBe(1);
      expect((await api.call("POST", `/api/events/${event.id}/scouts/${inHeat}/drop`)).status).toBe(200);

      const results = (await api.call("GET", `/api/events/${event.id}/results`)).body;
      expect(results.timeline.map((l: any) => l.type)).toEqual(["late_entrant", "drop"]);
      expect(results.event.scouts.find((s: any) => s.id === inHeat).dropped).toBe(true);
    });

    it("keeps account events to their owner", async () => {
      const owner = await h.signIn();
      const other = await h.signIn();
      const event = await makeEvent(owner);
      expect(event.isGuest).toBe(false);
      expect((await api.call("GET", `/api/events/${event.id}`)).status).toBe(403);
      expect((await api.call("GET", `/api/events/${event.id}`, { token: other })).status).toBe(403);
      expect((await api.call("GET", `/api/events/${event.id}`, { token: "not-a-token" })).status).toBe(403);
      expect((await api.call("GET", `/api/events/${event.id}`, { token: owner })).status).toBe(200);
      expect((await api.call("DELETE", `/api/events/${event.id}`, { token: other })).status).toBe(403);
      expect((await api.call("GET", "/api/events", { token: owner })).body.events.map((e: any) => e.id)).toEqual([event.id]);
      expect((await api.call("GET", "/api/events", { token: other })).body.events).toEqual([]);
      expect((await api.call("DELETE", `/api/events/${event.id}`, { token: owner })).status).toBe(204);
      expect((await api.call("GET", `/api/events/${event.id}`, { token: owner })).status).toBe(404);
    });

    it("lets an account claim a guest event, which then stops expiring", async () => {
      const event = await makeEvent();
      expect((await h.db.get<EventDoc>(collections.events, event.id))!.expireAt).toBeInstanceOf(Date);
      expect((await api.call("POST", `/api/events/${event.id}/claim`)).status).toBe(401);
      const owner = await h.signIn();
      const claimed = await api.call("POST", `/api/events/${event.id}/claim`, { token: owner });
      expect(claimed.body.isGuest).toBe(false);
      expect((await h.db.get<EventDoc>(collections.events, event.id))!.expireAt).toBeNull();
      expect((await api.call("POST", `/api/events/${event.id}/claim`, { token: await h.signIn() })).status).toBe(400);
      expect((await api.call("GET", `/api/events/${event.id}`)).status).toBe(403);
    });

    it("pairs a phone with a kiosk", async () => {
      const owner = await h.signIn();
      const event = await makeEvent(owner);
      const kiosk = (await api.call("POST", "/api/kiosk/sessions")).body.token;
      expect((await api.call("POST", `/api/kiosk/sessions/${kiosk}/bind`, { body: { eventId: event.id } })).status).toBe(403);
      expect((await api.call("POST", `/api/kiosk/sessions/${kiosk}/bind`, { token: owner, body: { eventId: event.id } })).status).toBe(200);
      // Bound, but not paired yet: no access to an account's event
      expect((await api.call("GET", `/api/events/${event.id}`, { kiosk })).status).toBe(403);

      const pairing = (await api.call("POST", `/api/kiosk/sessions/${kiosk}/pairing-request`)).body;
      expect(pairing.pairingCode).toMatch(/^\d{6}$/);
      const wrong = pairing.pairingCode === "000000" ? "111111" : "000000";
      expect((await api.call("POST", "/api/kiosk/pair", { body: { qrToken: pairing.qrToken, pairingCode: wrong } })).status).toBe(401);
      const paired = await api.call("POST", "/api/kiosk/pair", { body: pairing });
      expect(paired.body).toMatchObject({ token: kiosk, eventId: event.id });
      expect((await api.call("POST", "/api/kiosk/pair", { body: pairing })).status).toBe(404);

      expect((await api.call("GET", `/api/events/${event.id}`, { kiosk })).status).toBe(200);
      expect((await api.call("POST", `/api/events/${event.id}/scouts`, { kiosk, body: { name: "Ada" } })).status).toBe(201);
      const refreshed = await api.call("POST", "/api/kiosk/sessions/refresh", { kiosk });
      expect(refreshed.body.isBound).toBe(true);
      expect((await api.call("GET", `/api/kiosk/sessions/${kiosk}`)).body.eventId).toBe(event.id);
      expect((await api.call("GET", "/api/kiosk/sessions/nope")).status).toBe(404);
    });

    it("lets a guest kiosk link watch but not change an account's event", async () => {
      const owner = await h.signIn();
      const event = await makeEvent(owner);
      expect((await api.call("POST", `/api/events/${event.id}/guest-kiosk-link`, { token: await h.signIn() })).status).toBe(403);
      const link = await api.call("POST", `/api/events/${event.id}/guest-kiosk-link`, { token: owner });
      expect(link.status).toBe(201);
      expect((await api.call("POST", `/api/events/${event.id}/guest-kiosk-link`, { token: owner })).body.token).toBe(link.body.token);

      const kiosk = (await api.call("POST", `/api/guest-kiosk/${link.body.token}`)).body.token;
      expect((await api.call("GET", `/api/events/${event.id}`, { kiosk })).status).toBe(200);
      expect((await api.call("POST", `/api/events/${event.id}/scouts`, { kiosk, body: { name: "Ada" } })).status).toBe(403);

      expect((await api.call("DELETE", `/api/events/${event.id}/guest-kiosk-link`, { token: owner })).status).toBe(204);
      expect((await api.call("GET", `/api/events/${event.id}`, { kiosk })).status).toBe(403);
      expect((await api.call("POST", `/api/guest-kiosk/${link.body.token}`)).status).toBe(410);
      expect((await api.call("POST", "/api/guest-kiosk/nope")).status).toBe(404);
    });

    it("runs the popular vote", async () => {
      const event = await makeEvent(undefined, { pointLimit: 1 });
      await addRacers(event.id, ["Ada", "Ben"]);
      const { scouts } = (await api.call("GET", `/api/events/${event.id}`)).body;
      const vote = (id: string) => api.call("POST", `/api/events/${event.id}/popular-vote`, { body: { favoriteScoutId: id } });
      expect((await vote("nobody")).status).toBe(400);
      expect((await vote(scouts[1].id)).status).toBe(201);
      expect((await vote(scouts[1].id)).status).toBe(201);
      expect((await vote(scouts[0].id)).status).toBe(201);
      expect((await api.call("POST", `/api/events/${event.id}/popular-vote/reveal`)).status).toBe(400);

      const heat = (await api.call("POST", `/api/events/${event.id}/next-heat`)).body;
      await api.call("POST", `/api/events/${event.id}/heats/${heat.id}/result`, { body: { finishOrder: heat.laneAssignments } });
      const reveal = await api.call("POST", `/api/events/${event.id}/popular-vote/reveal`);
      expect(reveal.body).toMatchObject({ winnerScoutId: scouts[1].id, totalVotes: 3 });
      expect((await vote(scouts[0].id)).status).toBe(400);

      const tally = (await api.call("GET", `/api/events/${event.id}/popular-vote`)).body;
      expect(tally.ranks.map((r: any) => r.votes)).toEqual([2, 1]);
      expect(tally.winner.id).toBe(scouts[1].id);

      expect((await api.call("DELETE", `/api/events/${event.id}/guest`)).status).toBe(204);
      expect(await h.db.where(collections.votes, "eventId", event.id)).toEqual([]);
    });

    it("keeps Race Patrols and imports them into an event", async () => {
      const owner = await h.signIn();
      expect((await api.call("GET", "/api/patrols")).status).toBe(401);
      const made = await api.call("POST", "/api/patrols", { token: owner, body: { name: "Possums", racers: [{ name: "Ada", weight: 140 }, { name: "Ben" }] } });
      expect(made.status).toBe(201);
      expect((await api.call("GET", "/api/patrols", { token: await h.signIn() })).body.patrols).toEqual([]);

      const resync = await api.call("POST", "/api/patrols/import", {
        token: owner,
        body: {
          patrols: [
            { existingId: made.body.id, name: "Possums", racers: [{ name: "ada" }, { name: "Cy" }], source: "terrain",
              terrain: { unitId: "u1", unitName: "1st Town Cubs", scope: "patrol", patrol: "Possums", includeLeaders: false } },
            { name: "Wombats", racers: [{ name: "Dee" }], source: "csv" },
          ],
        },
      });
      expect(resync.body).toMatchObject({ created: 1, updated: 1, deleted: 0 });
      const possums = resync.body.patrols.find((p: any) => p.name === "Possums");
      expect(possums.racers.find((r: any) => r.name === "ada")).toMatchObject({ id: made.body.racers[0].id, weight: 140 });
      expect(possums.terrain).toMatchObject({ unitId: "u1", patrol: "Possums" });

      const event = await makeEvent(owner);
      const ids = resync.body.patrols.map((p: any) => p.id);
      const imported = await api.call("POST", `/api/events/${event.id}/scouts/import-patrols`, { token: owner, body: { patrolIds: ids } });
      expect(imported.body).toEqual({ created: 3, skipped: 0 });
      expect((await api.call("POST", `/api/events/${event.id}/scouts/import-patrols`, { token: owner, body: { patrolIds: ids } })).status).toBe(400);
      const state = (await api.call("GET", `/api/events/${event.id}`, { token: owner })).body;
      expect(state.scouts.map((s: any) => s.carNumber).sort()).toEqual(["1", "2", "3"]);

      const replaced = await api.call("POST", "/api/patrols/import", { token: owner, body: { replaceAll: true, patrols: [{ name: "All", racers: [{ name: "Eve" }] }] } });
      expect(replaced.body).toMatchObject({ created: 1, deleted: 2 });
      expect((await api.call("DELETE", `/api/patrols/${replaced.body.patrols[0].id}`, { token: await h.signIn() })).status).toBe(404);
      expect((await api.call("DELETE", `/api/patrols/${replaced.body.patrols[0].id}`, { token: owner })).status).toBe(204);
    });

    it("keeps race setups", async () => {
      const owner = await h.signIn();
      const made = await api.call("POST", "/api/race-setups", { token: owner, body: { name: "Hall", pointLimit: 3, lanes: 4, weightUnit: "oz" } });
      expect(made.body).toMatchObject({ name: "Hall", lanes: 4, weightUnit: "oz", theme: "system" });
      const changed = await api.call("PATCH", `/api/race-setups/${made.body.id}`, { token: owner, body: { lanes: 6 } });
      expect(changed.body.lanes).toBe(6);
      expect((await api.call("GET", "/api/race-setups", { token: owner })).body.setups.length).toBe(1);
      expect((await api.call("PATCH", `/api/race-setups/${made.body.id}`, { token: await h.signIn(), body: { lanes: 6 } })).status).toBe(404);
      expect((await api.call("DELETE", `/api/race-setups/${made.body.id}`, { token: owner })).status).toBe(204);
    });

    it("sends live updates to subscribed screens", async () => {
      const owner = await h.signIn();
      const event = await makeEvent(owner);
      const stranger = api.socket();
      const watcher = api.socket();
      const strangerUpdates: unknown[] = [];
      stranger.on("event:update", (e) => strangerUpdates.push(e));
      stranger.emit("event:subscribe", { eventId: event.id });

      const first = new Promise<any>((resolve) => watcher.once("event:update", resolve));
      watcher.emit("event:subscribe", { eventId: event.id, authToken: owner });
      expect((await first).id).toBe(event.id);

      const next = new Promise<any>((resolve) => watcher.once("event:update", resolve));
      await api.call("POST", `/api/events/${event.id}/scouts`, { token: owner, body: { name: "Ada" } });
      expect((await next).scouts.map((s: any) => s.name)).toEqual(["Ada"]);
      expect(strangerUpdates).toEqual([]);
    });

    it("closes a page from before straight away, and any connection with nothing happening for 30 minutes", async () => {
      const owner = await h.signIn();
      const event = await makeEvent(owner);
      // A page from before (no v: 2): closed by the server, and it doesn't come back
      const old = api.socket({ old: true });
      const reason = await new Promise<string>((resolve) => old.once("disconnect", resolve));
      expect(reason).toBe("io server disconnect");
      await new Promise((r) => setTimeout(r, 300));
      expect(old.connected).toBe(false);
      // Today's page, following the event: kept while things happen, closed after 30 quiet minutes
      const watcher = api.socket();
      const first = new Promise<any>((resolve) => watcher.once("event:update", resolve));
      watcher.emit("event:subscribe", { eventId: event.id, authToken: owner });
      await first;
      expect(api.closeIdle(Date.now() + 10 * 60_000)).toBe(0);
      await api.call("POST", `/api/events/${event.id}/scouts`, { token: owner, body: { name: "Ada" } });
      expect(api.closeIdle(Date.now() + IDLE_CLOSE_MS - 60_000)).toBe(0);   // the change just now counts
      const closed = new Promise<string>((resolve) => watcher.once("disconnect", resolve));
      expect(api.closeIdle(Date.now() + IDLE_CLOSE_MS + 1000)).toBeGreaterThanOrEqual(1);   // this one, and any left by earlier tests
      expect(await closed).toBe("io server disconnect");
    });
  });
}
