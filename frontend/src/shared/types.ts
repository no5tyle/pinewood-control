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
  winnerScoutId?: string;
};

export type RacePatrolRacer = {
  id: string;
  name: string;
  groupName?: string | null;
  weight?: number | null;
};

export type RacePatrol = {
  id: string;
  name: string;
  createdAt: number;
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
