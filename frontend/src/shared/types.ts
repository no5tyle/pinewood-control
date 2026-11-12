export type Scout = {
  id: string;
  name: string;
  carNumber: string;
  groupName?: string | null;
  weight?: number | null;
  eliminatedAt?: number | null;
  eliminatedHeatId?: string | null;
  dropped?: boolean;
  droppedAt?: number | null;
  sourcePatrolRacerId?: string | null;
  points: number;
  eliminated: boolean;
};

export type Heat = {
  id: string;
  laneAssignments: string[];
  finishOrder?: string[];
  loserScoutIds?: string[];
  createdAt?: number;
  winnerScoutId?: string;
};

export type RacePatrolRacer = {
  id: string;
  name: string;
  groupName?: string | null;
  weight?: number | null;
};

/** What a patrol imported from Terrain fetches again when resynced */
export type TerrainLink = {
  unitId: string;
  unitName: string;
  /** The whole unit, one Terrain patrol, or the youth without a patrol */
  scope: "unit" | "patrol" | "unpatrolled";
  patrol: string | null;
  includeLeaders: boolean;
};

export type RacePatrol = {
  id: string;
  name: string;
  createdAt: number;
  /** Where the racers came from: Terrain, a spreadsheet, or typed in (null) */
  source?: "terrain" | "csv" | null;
  terrain?: TerrainLink | null;
  /** When it was last brought up to date from Terrain */
  syncedAt?: number | null;
  racers: RacePatrolRacer[];
};

export type EventState = {
  id: string;
  name: string;
  pointLimit: number;
  lanes: number;
  setupComplete: boolean;
  theme: string;
  weightUnit?: "g" | "oz";
  popularVoteRevealAt?: number | null;
  popularVoteRevealCountdownSeconds?: number;
  popularVoteWinnerScoutId?: string | null;
  popularVoteWinner?: Scout | null;
  createdAt?: number;
  lastUsedAt?: number;
  completedAt?: number | null;
  isGuest: boolean;
  scouts: Scout[];
  heats: Heat[];
  standings: Scout[];
  currentHeatId?: string;
  championScoutId: string | null;
  isComplete: boolean;
};

export type KioskSessionStatus = {
  token: string;
  eventId: string | null;
  expiresAt: number;
  isBound: boolean;
};

export type EventResults = {
  event: EventState;
  completedAt: number | null;
  champion: Scout | null;
  timeline: Array<{
    id: string;
    type: "late_entrant" | "drop" | string;
    createdAt: number;
    scoutId: string | null;
    pointsPenalty: number | null;
  }>;
  popularVote: {
    totalVotes: number;
    revealAt: number | null;
    revealCountdownSeconds: number;
    winner: Scout | null;
    ranks: Array<{ scout: Scout; votes: number }>;
  };
  heatResults: Array<{
    id: string;
    createdAt: number;
    eliminatedScoutIds: string[];
    placements: Array<{ place: number; scout: Scout | null }>;
    winnerScoutId: string | null;
    loserScoutIds: string[];
  }>;
};

export type EventListResponse = {
  events: EventState[];
};

export type RacePatrolListResponse = {
  patrols: RacePatrol[];
};

export type ThemeName = "system" | "scouts-au-cubs" | "scouts-america";

/** A saved race setup: everything an event needs except its racers */
export type RaceSetup = {
  id: string;
  name: string;
  pointLimit: number;
  lanes: number;
  theme: ThemeName;
  weightUnit: "g" | "oz";
  updatedAt: number;
};
