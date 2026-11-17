/*
  Where Pinewood keeps its data: Firestore in production, and an in-memory copy for tests and local runs.

  The rest of the server only sees this small interface. Documents are plain objects; `expireAt` (a Date)
  is the field Firestore's TTL policy deletes by, so short-lived records (kiosk sessions, pairing
  requests, guest links and unclaimed guest events) need no cleanup timers. Firestore can take up to a
  day to delete them, so the code still checks expiry times itself.
*/
import type { Firestore } from "firebase-admin/firestore";

export const collections = {
  events: "pinewoodEvents",
  votes: "pinewoodVotes",
  patrols: "pinewoodPatrols",
  setups: "pinewoodSetups",
  kioskSessions: "pinewoodKioskSessions",
  pairings: "pinewoodPairings",
  guestLinks: "pinewoodGuestLinks",
} as const;

export type Collection = (typeof collections)[keyof typeof collections];

/** Thrown from inside a route (or an update) to answer with a status and message. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Db {
  get<T>(col: Collection, id: string): Promise<T | null>;
  set<T extends object>(col: Collection, id: string, data: T): Promise<void>;
  delete(col: Collection, id: string): Promise<void>;
  /** Every document whose `field` equals `value`. */
  where<T>(col: Collection, field: string, value: string): Promise<T[]>;
  /**
   * Reads, changes and writes one document atomically. `change` gets the current document (null if there
   * isn't one) and returns the new one, or null to leave it as it is. It may run more than once, so it
   * mustn't do anything else. Gives what was written, or the document unchanged.
   */
  update<T extends object>(col: Collection, id: string, change: (current: T | null) => T | null): Promise<T | null>;
}

// Firestore gives Timestamps back for Dates; the server only ever reads expireAt as a Date.
function fromFirestore<T>(data: FirebaseFirestore.DocumentData | undefined): T | null {
  if (!data) return null;
  const out = { ...data };
  if (out.expireAt && typeof out.expireAt.toDate === "function") out.expireAt = out.expireAt.toDate();
  return out as T;
}

export class FirestoreDb implements Db {
  constructor(private readonly firestore: Firestore) {}

  async get<T>(col: Collection, id: string) {
    return fromFirestore<T>((await this.firestore.collection(col).doc(id).get()).data());
  }

  async set<T extends object>(col: Collection, id: string, data: T) {
    await this.firestore.collection(col).doc(id).set(data);
  }

  async delete(col: Collection, id: string) {
    await this.firestore.collection(col).doc(id).delete();
  }

  async where<T>(col: Collection, field: string, value: string) {
    const snap = await this.firestore.collection(col).where(field, "==", value).get();
    return snap.docs.map((d) => fromFirestore<T>(d.data()) as T);
  }

  async update<T extends object>(col: Collection, id: string, change: (current: T | null) => T | null) {
    const ref = this.firestore.collection(col).doc(id);
    return this.firestore.runTransaction(async (tx) => {
      const current = fromFirestore<T>((await tx.get(ref)).data());
      const next = change(current);
      if (next === null) return current;
      tx.set(ref, next);
      return next;
    });
  }
}

/** Keeps everything in memory, copying on the way in and out as Firestore would. */
export class MemoryDb implements Db {
  private readonly data = new Map<string, Map<string, object>>();

  private col(col: Collection) {
    let docs = this.data.get(col);
    if (!docs) this.data.set(col, (docs = new Map()));
    return docs;
  }

  async get<T>(col: Collection, id: string) {
    const doc = this.col(col).get(id);
    return doc ? (structuredClone(doc) as T) : null;
  }

  async set<T extends object>(col: Collection, id: string, data: T) {
    this.col(col).set(id, structuredClone(stripUndefined(data)));
  }

  async delete(col: Collection, id: string) {
    this.col(col).delete(id);
  }

  async where<T>(col: Collection, field: string, value: string) {
    return [...this.col(col).values()]
      .filter((d) => (d as Record<string, unknown>)[field] === value)
      .map((d) => structuredClone(d) as T);
  }

  async update<T extends object>(col: Collection, id: string, change: (current: T | null) => T | null) {
    const current = await this.get<T>(col, id);
    const next = change(current);
    if (next === null) return current;
    await this.set(col, id, next);
    return structuredClone(next);
  }
}

// Firestore is set up to skip undefined fields; this does the same for the memory copy.
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]),
    ) as T;
  }
  return value;
}
