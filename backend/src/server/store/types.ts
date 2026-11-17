/*
  The documents Pinewood stores. Times are milliseconds since 1970, except `expireAt`, a Date that
  Firestore's TTL policy deletes the document by.

  An event is one document holding its racers, heats and log, so a race-day change (a result, a new heat)
  is a single atomic update and the live screens get the whole event in one read.
*/
export type ScoutDoc = {
  id: string;
  name: string;
  carNumber: string;
  groupName: string | null;
  weight: number | null;
  points: number;
  eliminated: boolean;
  eliminatedAt: number | null;
  eliminatedHeatId: string | null;
  dropped: boolean;
  droppedAt: number | null;
  /** The Race Patrol racer this racer was imported from */
  sourcePatrolRacerId: string | null;
  /** The lane numbers raced so far */
  laneHistory: number[];
  /** Heats counted as raced for a late entrant, so they catch up with the field */
  heatCountOffset: number;
};

export type HeatDoc = {
  id: string;
  /** Racer ids by lane (lane 1 first) */
  laneAssignments: string[];
  /** Racer ids, winner first; empty until the result is in */
  finishOrder: string[];
  loserScoutIds: string[];
  /** Each racer's time in seconds from an electronic timer, when one was used */
  laneTimes: Record<string, number | null>;
  winnerScoutId: string | null;
  createdAt: number;
};

export type EventLogDoc = {
  id: string;
  type: "late_entrant" | "drop";
  createdAt: number;
  scoutId: string | null;
  pointsPenalty: number | null;
};

export type EventDoc = {
  id: string;
  name: string;
  pointLimit: number;
  lanes: number;
  setupComplete: boolean;
  isGuest: boolean;
  theme: string;
  weightUnit: "g" | "oz";
  popularVoteRevealAt: number | null;
  popularVoteWinnerScoutId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** The qstored account (Firebase uid) that owns it; null for an unclaimed guest event */
  userId: string | null;
  /** Unclaimed guest events are deleted after a day */
  expireAt: Date | null;
  scouts: ScoutDoc[];
  heats: HeatDoc[];
  logs: EventLogDoc[];
};

export type VoteDoc = { id: string; eventId: string; favoriteScoutId: string; createdAt: number; expireAt: Date | null };

export type PatrolRacerDoc = { id: string; name: string; groupName: string | null; weight: number | null };

export type PatrolDoc = {
  id: string;
  userId: string;
  name: string;
  source: "terrain" | "csv" | null;
  terrain: {
    unitId: string;
    unitName: string;
    scope: "unit" | "patrol" | "unpatrolled";
    patrol: string | null;
    includeLeaders: boolean;
  } | null;
  syncedAt: number | null;
  createdAt: number;
  updatedAt: number;
  racers: PatrolRacerDoc[];
};

export type SetupDoc = {
  id: string;
  userId: string;
  name: string;
  pointLimit: number;
  lanes: number;
  theme: string;
  weightUnit: "g" | "oz";
  createdAt: number;
  updatedAt: number;
};

/** A kiosk screen or a paired phone. Stored under its token. */
export type KioskSessionDoc = {
  token: string;
  expiresAt: number;
  /** Until when it may open an account's event (set by pairing, or a guest kiosk link) */
  accessExpiresAt: number | null;
  eventId: string | null;
  /** Made from a guest kiosk link: it can watch, but not change, the event */
  guestKioskLinkId: string | null;
  expireAt: Date;
};

/** Stored under its QR token. */
export type PairingDoc = { qrToken: string; pairingCode: string; kioskToken: string; expiresAt: number; expireAt: Date };

/** Stored under its id; the token is what goes in the link. */
export type GuestLinkDoc = {
  id: string;
  token: string;
  eventId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  expireAt: Date;
};
