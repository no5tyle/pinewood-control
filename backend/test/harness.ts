/**
 * The same tests run two ways: against the in-memory store with a stand-in for sign-in (always), and
 * against the Firestore and Firebase Authentication emulators (`npm run test:emulators`, and CI).
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { closeIdle, IDLE_CLOSE_MS } from "../src/server/socketHandlers.js";
export { IDLE_CLOSE_MS };
import { FirebaseTokenAuth, type Auth } from "../src/server/auth.js";
import { FirestoreDb, MemoryDb, type Db } from "../src/server/store/db.js";

export interface Harness {
  name: string;
  db: Db;
  /** Signs a new person in, and gives their token. */
  signIn(): Promise<string>;
  /** Starts the server on a free port. */
  start(): Promise<Server>;
}

export interface Server {
  call(method: string, path: string, options?: { token?: string; kiosk?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** A live connection as today's pages make one; `{ old: true }` as pages from before (no `v: 2`). */
  socket(options?: { old?: boolean }): Socket;
  /** Runs the sweep that closes connections with nothing to follow, as at `now`. */
  closeIdle(now: number): number;
  stop(): Promise<void>;
}

function starter(db: Db, auth: Auth) {
  return async (): Promise<Server> => {
    const { httpServer, io } = createApp({ db, auth, corsOrigins: [] });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const sockets: Socket[] = [];
    return {
      async call(method, path, { token, kiosk, body } = {}) {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;
        if (kiosk) headers["x-kiosk-token"] = kiosk;
        const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      },
      socket({ old = false } = {}) {
        const socket = connect(base, { transports: ["websocket"], forceNew: true, ...(old ? {} : { auth: { v: 2 } }) });
        sockets.push(socket);
        return socket;
      },
      closeIdle(now) {
        return closeIdle(io, now);
      },
      async stop() {
        sockets.forEach((s) => s.disconnect());
        await io.close();
      },
    };
  };
}

function memoryHarness(): Harness {
  const db = new MemoryDb();
  const auth: Auth = {
    async verify(token) {
      const [kind, uid] = token.split(":");
      return kind === "test" && uid ? { id: uid, email: `${uid}@example.com` } : null;
    },
  };
  return { name: "in memory", db, start: starter(db, auth), async signIn() { return `test:${randomUUID()}`; } };
}

function emulatorHarness(): Harness {
  const firebase = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-qstored" }, `test-${randomUUID()}`);
  const firestore = getFirestore(firebase);
  firestore.settings({ ignoreUndefinedProperties: true });
  const db = new FirestoreDb(firestore);
  return {
    name: "on the emulators",
    db,
    start: starter(db, new FirebaseTokenAuth(getAuth(firebase))),
    async signIn() {
      const call = async (path: string, body: object) => {
        const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=test`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, returnSecureToken: true }),
        });
        return (await res.json()) as { idToken: string; localId: string };
      };
      const login = { email: `${randomUUID()}@example.com`, password: randomUUID() };
      const created = await call("accounts:signUp", login);
      // Confirmed, as an emailed link confirms it: unconfirmed sign-ins aren't accounts (see userFrom)
      await getAuth(firebase).updateUser(created.localId, { emailVerified: true });
      return (await call("accounts:signInWithPassword", login)).idToken;
    },
  };
}

export const harnesses: Harness[] = [
  memoryHarness(),
  ...(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST ? [emulatorHarness()] : []),
];
