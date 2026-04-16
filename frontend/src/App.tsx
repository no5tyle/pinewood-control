import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import QRCode from "qrcode";
import socketIOClient from "socket.io-client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import appConfig from "./appConfig.json";

type Scout = {
  id: string;
  name: string;
  carNumber: string;
  groupName?: string | null;
  weight?: number | null;
  eliminatedAt?: number | null;
  eliminatedHeatId?: string | null;
  dropped?: boolean;
  droppedAt?: number | null;
  points: number;
  eliminated: boolean;
};

type Heat = {
  id: string;
  laneAssignments: string[];
  winnerScoutId?: string;
};

type RacePatrolRacer = {
  id: string;
  name: string;
  groupName?: string | null;
  weight?: number | null;
};

type RacePatrol = {
  id: string;
  name: string;
  createdAt: number;
  racers: RacePatrolRacer[];
};

type EventState = {
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
  isGuest: boolean;
  scouts: Scout[];
  heats: Heat[];
  standings: Scout[];
  currentHeatId?: string;
  championScoutId: string | null;
  isComplete: boolean;
};

type KioskSessionStatus = {
  token: string;
  eventId: string | null;
  expiresAt: number;
  isBound: boolean;
};

type EventResults = {
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

type EventListResponse = {
  events: EventState[];
};

type RacePatrolListResponse = {
  patrols: RacePatrol[];
};

function getApiOrigin(): string {
  const value = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

const apiOrigin = getApiOrigin();
const socket = socketIOClient(apiOrigin || "/");
const kioskSessionStorageKey = "pinewood_kiosk_session";
const guestEventStorageKey = "pinewood_guest_event_ids";
const guestAccessUrlStorageKey = "pinewood_guest_access_urls";
const quickStartDismissedStorageKey = "pinewood_quickstart_dismissed_v1";
const guestClaimStatusEventName = "pinewood:guest-events-claim-status";
const quickStartOpenEventName = "pinewood:quickstart-open";
const donateOpenEventName = "pinewood:donate-open";
type ThemeName = "system" | "scouts-au-cubs" | "scouts-america";

function safeParseStorageJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function copyToClipboardWithFallback(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("Copy this:", text);
  }
}

function getLocalGuestEventIds(): string[] {
  const ids = safeParseStorageJSON<string[]>(window.localStorage.getItem(guestEventStorageKey), []);
  return ids.filter((id) => typeof id === "string" && id.length > 0);
}

function setLocalGuestEventIds(ids: string[]) {
  const normalized = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  const currentNormalized = Array.from(new Set(getLocalGuestEventIds()));
  if (normalized.length === currentNormalized.length && normalized.every((id, idx) => id === currentNormalized[idx])) {
    return;
  }
  window.localStorage.setItem(guestEventStorageKey, JSON.stringify(normalized));
  window.dispatchEvent(new Event("pinewood:guest-events-changed"));
}

function addLocalGuestEventId(eventId: string) {
  setLocalGuestEventIds([...getLocalGuestEventIds(), eventId]);
}

function removeLocalGuestEventId(eventId: string) {
  setLocalGuestEventIds(getLocalGuestEventIds().filter((id) => id !== eventId));
}

function getStoredGuestAccessUrls(): Record<string, { url: string; expiresAt: number }> {
  const raw = safeParseStorageJSON<Record<string, { url?: unknown; expiresAt?: unknown }>>(
    window.localStorage.getItem(guestAccessUrlStorageKey),
    {}
  );
  const now = Date.now();
  const out: Record<string, { url: string; expiresAt: number }> = {};
  for (const [eventId, value] of Object.entries(raw)) {
    const url = typeof value?.url === "string" ? value.url : "";
    const expiresAt = typeof value?.expiresAt === "number" ? value.expiresAt : 0;
    if (!eventId || !url || !expiresAt || expiresAt <= now) continue;
    out[eventId] = { url, expiresAt };
  }
  return out;
}

function setStoredGuestAccessUrls(value: Record<string, { url: string; expiresAt: number }>) {
  window.localStorage.setItem(guestAccessUrlStorageKey, JSON.stringify(value));
}

function isAuthRequiredError(message: string): boolean {
  return message.toLowerCase().includes("authentication required to access this event");
}

function ClaimLocalGuestEventsOnAuth() {
  const { user } = useAuth();
  const attemptRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const userId = user?.id ?? null;
    if (!userId) return;

    attemptRef.current = 0;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);

    const claimOnce = async () => {
      const ids = getLocalGuestEventIds();
      if (ids.length === 0) return;

      window.dispatchEvent(
        new CustomEvent(guestClaimStatusEventName, { detail: { inProgress: true, remaining: ids.length } })
      );

      const results = await Promise.allSettled(ids.map((eventId) => api(`/events/${eventId}/claim`, { method: "POST" })));
      const remaining: string[] = [];
      let succeeded = 0;
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          succeeded += 1;
          return;
        }
        const message = (r.reason as Error | undefined)?.message ?? "";
        if (message.includes("Event not found") || message.includes("Event already claimed") || isAuthRequiredError(message)) return;
        remaining.push(ids[idx]);
      });

      setLocalGuestEventIds(remaining);
      if (succeeded > 0) {
        window.dispatchEvent(new Event("pinewood:guest-events-claimed"));
      }

      window.dispatchEvent(
        new CustomEvent(guestClaimStatusEventName, {
          detail: { inProgress: remaining.length > 0, remaining: remaining.length },
        })
      );

      attemptRef.current += 1;
      if (remaining.length > 0 && attemptRef.current < 4) {
        timeoutRef.current = window.setTimeout(() => {
          void claimOnce().catch(() => undefined);
        }, 5000);
      }
    };

    void claimOnce().catch(() => undefined);

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  return null;
}

function getQrPrefix(): string {
  const canonical = "https://pinewood.nostyle.app";
  const envPrefix = import.meta.env.VITE_QR_PREFIX as string | undefined;
  if (envPrefix && envPrefix.trim().length > 0) {
    const normalized = envPrefix.trim().replace(/\/+$/, "");
    if (normalized === "https://nostyle.app" || normalized === "https://www.nostyle.app") return canonical;
    return normalized;
  }

  if (window.location.hostname === "nostyle.app" || window.location.hostname === "www.nostyle.app") {
    return canonical;
  }

  if (window.location.hostname === "pinewood.nostyle.app") {
    return canonical;
  }

  const filePrefix = appConfig.qrPrefix?.trim();
  if (filePrefix && (window.location.hostname === "localhost" || window.location.hostname.startsWith("192.168.") || window.location.hostname.startsWith("10."))) {
    return filePrefix.replace(/\/+$/, "");
  }

  return window.location.origin.replace(/\/+$/, "");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("auth_token");
  const kioskToken = localStorage.getItem(kioskSessionStorageKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (kioskToken) {
    headers["X-Kiosk-Token"] = kioskToken;
  }

  const base = apiOrigin.length > 0 ? apiOrigin : "";
  const res = await fetch(`${base}/api${path}`, {
    headers,
    cache: "no-store",
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "Request failed");
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// --- Components ---

function AuthRequiredPage({ message }: { message?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <main className="home-page auth-required-page">
      <section className="card auth-required-card">
        <h1>Authentication Required</h1>
        <p className="muted">
          {user
            ? "This event is owned by a different account, or your access has expired."
            : "This event is owned by an account. Login to access it if it’s yours, or return to Events."}
        </p>
        {message ? <p className="muted">{message}</p> : null}
        <div className="auth-required-actions">
          <button className="secondary-btn" onClick={() => navigate("/")}>Home</button>
          {!user ? <button onClick={() => navigate("/login")}>Login</button> : null}
        </div>
      </section>
    </main>
  );
}

function PageTitle() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;
    let pageName = "Home";

    if (path === "/") pageName = "Home";
    else if (path === "/events") pageName = "My Events";
    else if (path === "/patrols") pageName = "Race Patrols";
    else if (path === "/help") pageName = "Help";
    else if (path === "/login") pageName = "Login";
    else if (path === "/signup") pageName = "Signup";
    else if (path.startsWith("/kiosk/")) pageName = "Kiosk";
    else if (path.startsWith("/control/")) pageName = "Controller";
    else if (path.startsWith("/configure/")) pageName = "Configure";
    else if (path.startsWith("/events/") && path.endsWith("/scouts")) pageName = "Racers";
    else if (path.startsWith("/results/")) pageName = "Results";
    else if (path.startsWith("/pair/")) pageName = "Pair Device";
    else if (path.startsWith("/guest-kiosk/")) pageName = "Guest Kiosk";

    document.title = `Pinewood Controller - ${pageName}`;
  }, [location.pathname]);

  return null;
}

function QuickStartOverlay() {
  const navigate = useNavigate();
  const location = useLocation();
  const [forcedOpen, setForcedOpen] = useState(false);

  const close = useCallback(() => {
    window.localStorage.setItem(quickStartDismissedStorageKey, "1");
    setForcedOpen(false);
  }, []);

  const dismissed = window.localStorage.getItem(quickStartDismissedStorageKey) === "1";
  const autoOpen = !dismissed && (location.pathname === "/" || location.pathname === "/events");
  const open = forcedOpen || autoOpen;

  useEffect(() => {
    const onOpen = () => setForcedOpen(true);
    window.addEventListener(quickStartOpenEventName, onOpen);
    return () => window.removeEventListener(quickStartOpenEventName, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="quickstart-overlay" role="dialog" aria-modal="true" aria-label="Quick start guide">
      <section className="card quickstart-card">
        <button className="close-overlay" onClick={close} aria-label="Close" autoFocus>×</button>
        <h2 style={{ margin: 0 }}>Quick Start</h2>
        <p className="muted" style={{ margin: 0 }}>
          Create an event, link an operator device, then run heats and submit results.
        </p>
        <ol className="quickstart-steps">
          <li>Create an event (guest or signed-in).</li>
          <li>Open the Kiosk on the display device.</li>
          <li>Link the operator device by scanning the QR and entering the pairing code.</li>
          <li>Add racers, generate heats, then submit the full finish order after each race.</li>
        </ol>
        <div className="quickstart-actions">
          <button className="secondary-btn" onClick={() => { close(); navigate("/help"); }}>More</button>
          <div style={{ flex: 1 }} />
          <button onClick={close}>Get Started</button>
        </div>
      </section>
    </div>
  );
}

function DonateOverlay() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(donateOpenEventName, onOpen);
    return () => window.removeEventListener(donateOpenEventName, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="quickstart-overlay" role="dialog" aria-modal="true" aria-label="Support Pinewood Controller">
      <section className="card quickstart-card">
        <button className="close-overlay" onClick={close} aria-label="Close" autoFocus>×</button>
        <h2 style={{ margin: 0 }}>Support this project</h2>
        <p className="muted" style={{ margin: 0 }}>
          Donations are used to cover server hosting and, beyond that, other scouting-related things.
        </p>
        <div className="donate-link-card">
          <div className="donate-link-title">ko-fi.com/nostyle</div>
          <a className="donate-link-btn" href="https://ko-fi.com/nostyle" target="_blank" rel="noreferrer">
            Donate on Ko-fi
          </a>
        </div>
        <div className="quickstart-actions">
          <div style={{ flex: 1 }} />
          <button onClick={close}>Close</button>
        </div>
      </section>
    </div>
  );
}

function HelpPage() {
  return (
    <main className="home-page">
      <AppHeader />
      <section className="card">
        <h1>Help</h1>
        <p className="muted">How to run a race, how matchups are generated, and how rankings are calculated.</p>
      </section>

      <section className="card">
        <h2>Quick Start</h2>
        <ol style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Create an event (guest or signed-in).</li>
          <li>Configure lanes, elimination points, and theme (System uses your device light/dark).</li>
          <li>Add racers (name + car number).</li>
          <li>Open the Kiosk on the display device.</li>
          <li>Link an operator device by scanning the QR and entering the pairing code.</li>
          <li>Generate the next heat, then submit the full finish order after each race.</li>
        </ol>
      </section>

      <section className="card">
        <h2>Operator Controls</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Generate Heat creates the next matchup (minimum 2 active racers).</li>
          <li>Submit Result records the finish order and updates points + eliminations.</li>
          <li>When only one active racer remains, the event is complete and the kiosk switches to Final Standings.</li>
        </ul>
      </section>

      <section className="card">
        <h2>How Matchups Are Made</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>The system only generates heats when there are at least 2 non-eliminated racers available.</li>
          <li>Primary goal: keep “heats raced” balanced so nobody races twice before everyone has raced once (where possible).</li>
          <li>It prefers matchups where racers face new opponents (avoiding repeat pairings when possible).</li>
          <li>It also tries to keep lane assignments fair over time.</li>
          <li>If it cannot generate a valid heat with the remaining racers, it will refuse rather than create a single-car heat.</li>
        </ul>
        <details style={{ marginTop: "0.5rem" }}>
          <summary>Matchmaking details (expand)</summary>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
            <div>
              <div style={{ fontWeight: 800 }}>1) Heat participation balance (highest priority)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>Each racer tracks how many heats they’ve run so far.</li>
                <li>The next heat is built primarily from racers with the lowest heat count, so everyone gets a turn before anyone repeats (when possible).</li>
                <li>This can intentionally create heats with empty lanes to keep participation fair.</li>
                <li>Example: with 6 racers on a 4-lane track, it will prefer two 3-racer heats (3 + 3) rather than a 4 + 2 that forces repeats sooner.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>2) Opponent variety (next priority)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>After participation is balanced, it prefers heats where racers haven’t faced each other yet.</li>
                <li>It tries to avoid repeating the same pairings until necessary.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>3) Lane fairness</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>Within the chosen group, it assigns lanes to reduce how often each racer repeats the same lane.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>4) Competitiveness (points)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>As a final tie-breaker, it prefers racers with closer points to keep heats competitive.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>What it will never do</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>It won’t generate a heat with fewer than 2 active racers.</li>
              </ul>
            </div>
          </div>
        </details>
      </section>

      <section className="card">
        <h2>Rankings & Elimination</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Each heat awards points by finish position: 1st = 0 points, 2nd = 1 point, 3rd = 2 points, etc.</li>
          <li>Total points accumulate across heats.</li>
          <li>A racer is eliminated when points are greater than or equal to the event point limit.</li>
          <li>Standings sort by: not eliminated first.</li>
          <li>Eliminated racers are ranked by who survived longer (eliminated later ranks higher), then lowest points, then name.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Accounts vs Guest</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Guest is best for quick setup on a single device. Guest events are stored locally on the creating device and unclaimed guest events are deleted after 24 hours.</li>
          <li>An account is best if you want your events to appear across devices, or you want long-term storage and management.</li>
          <li>If you start as a guest and later login on that same device, locally-known guest events are moved into your account.</li>
          <li>Generate Guest Access URL allows an unauthed device to open a read-only kiosk for a claimed event. You can revoke it at any time to decommission access.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Inspiration</h2>
        <p className="muted">
          This project is heavily inspired by the Derby Day! race management software and its ladderless elimination approach.
          If you are on Windows and want a dedicated desktop app, Derby Day! is a great alternative.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <a href="https://derbydaysoftware.com/" target="_blank" rel="noopener noreferrer" className="direct-link">
            Derby Day! (alternative)
          </a>
        </p>
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Derby Day! is Windows-only (.NET), as a Mac and Linux user I wanted an easy to use cross platform alternative.
        </p>
      </section>

      <section className="card">
        <h2>Created By</h2>
        <p>
          Plover
        </p>
        <p className="muted">
          Cub Scout Leader at the Strathalbyn Scout Group
        </p>
      </section>
    </main>
  );
}

function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ token: string; user: { id: string; email: string; name?: string } }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      login(res.token, res.user);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
        <h1>Login</h1>
        <form onSubmit={handleSubmit} className="stack">
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Login</button>
        </form>
        <p style={{ marginTop: "1rem", textAlign: "center" }}>
          Don't have an account? <Link to="/signup">Sign up</Link>
        </p>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

function SignupPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ token: string; user: { id: string; email: string; name?: string } }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      });
      login(res.token, res.user);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
        <h1>Sign Up</h1>
        <form onSubmit={handleSubmit} className="stack">
          <label>Name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit">Create Account</button>
        </form>
        <p style={{ marginTop: "1rem", textAlign: "center" }}>
          Already have an account? <Link to="/login">Login</Link>
        </p>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.59 13.41a1 1 0 0 1 0-1.41l3.3-3.3a3 3 0 0 1 4.24 4.24l-2.83 2.83a3.5 3.5 0 0 1-4.95 0 1 1 0 1 1 1.41-1.41 1.5 1.5 0 0 0 2.12 0l2.83-2.83a1 1 0 1 0-1.41-1.41l-3.3 3.3a1 1 0 0 1-1.41 0Z"
      />
      <path
        fill="currentColor"
        d="M13.41 10.59a1 1 0 0 1 0 1.41l-3.3 3.3a3 3 0 0 1-4.24-4.24l2.83-2.83a3.5 3.5 0 0 1 4.95 0 1 1 0 0 1-1.41 1.41 1.5 1.5 0 0 0-2.12 0L7.29 11.5a1 1 0 1 0 1.41 1.41l3.3-3.3a1 1 0 0 1 1.41 0Z"
      />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm0-5a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 12 15Zm0-10a4 4 0 0 0-4 4 1 1 0 1 0 2 0 2 2 0 1 1 3.2 1.6c-.87.65-1.2 1.17-1.2 2.4a1 1 0 1 0 2 0c0-.63.14-.88.8-1.38A4 4 0 0 0 12 5Z"
      />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 21s-7-4.35-9.33-8.46C.76 9.06 2.2 5.5 5.9 4.6c1.9-.46 3.7.2 4.96 1.6 1.26-1.4 3.06-2.06 4.96-1.6 3.7.9 5.14 4.46 3.23 7.94C19 16.65 12 21 12 21Z"
      />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 2h12v2h3v4c0 3.3-2.7 6-6 6h-.2A6.02 6.02 0 0 1 13 15.66V18h4v2H7v-2h4v-2.34A6.02 6.02 0 0 1 9.2 14H9c-3.3 0-6-2.7-6-6V4h3V2Zm2 2v7c0 2.2 1.8 4 4 4s4-1.8 4-4V4H8Zm11 2h-1v5.1c1.2-.6 2-1.9 2-3.4V6ZM6 11.1V6H5v1.7c0 1.5.8 2.8 2 3.4Z"
      />
    </svg>
  );
}

function PatrolIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-6 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm12 9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1c0-3.3 2.7-6 6-6h8c3.3 0 6 2.7 6 6Zm-2-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4h16Z"
      />
    </svg>
  );
}

function AppHeader({ onRelink }: { onRelink?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <header className="app-header">
      <Link to="/" className="app-brand">Pinewood Control</Link>
      <div className="app-header-actions">
        {onRelink ? (
          <button className="profile-btn relink-btn" onClick={onRelink} aria-label="Re-pair device">
            <span className="profile-icon" aria-hidden="true"><LinkIcon /></span>
            <span>Re-pair</span>
          </button>
        ) : null}
        <Link to="/events" className="profile-btn" aria-label="View events">
          <span className="profile-icon" aria-hidden="true"><TrophyIcon /></span>
          <span>Events</span>
        </Link>
        {user ? (
          <Link to="/patrols" className="profile-btn" aria-label="Race patrols">
            <span className="profile-icon" aria-hidden="true"><PatrolIcon /></span>
            <span>Patrols</span>
          </Link>
        ) : null}
        <button
          type="button"
          className="profile-btn"
          aria-label="Help"
          onClick={() => window.dispatchEvent(new Event(quickStartOpenEventName))}
        >
          <span className="profile-icon" aria-hidden="true"><HelpIcon /></span>
          <span>Help</span>
        </button>
        <button
          type="button"
          className="profile-btn"
          aria-label="Donate"
          onClick={() => window.dispatchEvent(new Event(donateOpenEventName))}
        >
          <span className="profile-icon" aria-hidden="true"><HeartIcon /></span>
          <span>Donate</span>
        </button>
        {user ? (
          <div className="user-nav">
            <span className="user-name">{user.name || user.email}</span>
            <button className="profile-btn" onClick={logout}>Logout</button>
          </div>
        ) : (
          <Link to="/login" className="profile-btn">Login</Link>
        )}
      </div>
    </header>
  );
}

function useEvent(eventId?: string) {
  const [event, setEvent] = useState<EventState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!eventId) return;
    const fetchEvent = () => {
      api<EventState>(`/events/${eventId}?t=${Date.now()}`)
        .then(setEvent)
        .catch((e: Error) => {
          if (isAuthRequiredError(e.message)) {
            removeLocalGuestEventId(eventId);
          }
          setError(e.message);
        });
    };

    fetchEvent();

    const subscribe = () => {
      const authToken = window.localStorage.getItem("auth_token");
      const kioskToken = window.localStorage.getItem(kioskSessionStorageKey);
      socket.emit("event:subscribe", { eventId, authToken, kioskToken });
    };

    subscribe();
    const handler = (nextEvent: EventState) => {
      if (nextEvent.id === eventId) setEvent(nextEvent);
    };
    const reconnectHandler = () => {
      subscribe();
      fetchEvent();
    };

    socket.on("event:update", handler);
    socket.on("connect", reconnectHandler);

    // Fallback for environments where websocket updates are unreliable.
    const pollId = window.setInterval(fetchEvent, 1500);

    return () => {
      socket.off("event:update", handler);
      socket.off("connect", reconnectHandler);
      window.clearInterval(pollId);
    };
  }, [eventId]);

  return { event, error, setEvent };
}

function KioskBootPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const startKiosk = async () => {
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/kiosk/bootstrap", { method: "POST" });
      window.localStorage.setItem(kioskSessionStorageKey, res.token);
      navigate(`/kiosk/new`);
    } catch {
      setLoading(false);
    }
  };

  if (user) {
    return <Navigate to="/events" replace />;
  }

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card success" style={{ textAlign: "center", padding: "4rem 2rem" }}>
        <h1>Pinewood Derby Control</h1>
        <p>Ready to start a new tournament?</p>
        <button onClick={startKiosk} disabled={loading} style={{ fontSize: "1.5rem", padding: "1rem 2rem" }}>
          {loading ? "Starting..." : "Create Guest Event"}
        </button>
        <p className="muted" style={{ marginTop: "2rem" }}>
          Guest events are temporary. <Link to="/login">Login</Link> to save your races permanently.
        </p>
      </section>
    </main>
  );
}

function ConfigurePage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const { user } = useAuth();
  const [session, setSession] = useState<KioskSessionStatus | null>(null);
  const [event, setEvent] = useState<EventState | null>(null);
  const [pointLimit, setPointLimit] = useState<string>("10");
  const [lanes, setLanes] = useState<string>("4");
  const [theme, setTheme] = useState<ThemeName>("system");
  const [weightUnit, setWeightUnit] = useState<"g" | "oz">("g");
  const [error, setError] = useState("");
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (!token) return;
    api<KioskSessionStatus>(`/kiosk/sessions/${token}`)
      .then((s) => {
        setSession(s);
        if (!s.eventId) throw new Error("No event linked to this kiosk session.");
        return api<EventState>(`/events/${s.eventId}`);
      })
      .then((e) => {
        if (e.setupComplete) {
          navigate(`/control/${e.id}`, { replace: true });
          return;
        }
        setEvent(e);
        setPointLimit(String(e.pointLimit));
        setLanes(String(e.lanes));
        setTheme(e.theme as ThemeName);
        setWeightUnit(e.weightUnit === "oz" ? "oz" : "g");
      })
      .catch((err: Error) => setError(err.message));
  }, [token, navigate]);

  const saveAndNext = async (e: FormEvent) => {
    e.preventDefault();
    if (!session?.eventId) return;
    
    if (step === 1) return;

    if (step === 2) {
      const lanesNum = Number(lanes);
      if (!Number.isFinite(lanesNum) || lanes.trim().length === 0) {
        setError("Please enter the number of lanes.");
        return;
      }
      if (lanesNum < 2 || lanesNum > 12) {
        setError("Lanes must be between 2 and 12.");
        return;
      }
      setError("");
      setStep(3);
      return;
    }

    try {
      const lanesNum = Number(lanes);
      if (!Number.isFinite(lanesNum) || lanes.trim().length === 0) {
        setError("Please enter the number of lanes.");
        return;
      }
      if (lanesNum < 2 || lanesNum > 12) {
        setError("Lanes must be between 2 and 12.");
        return;
      }

      const pointLimitNum = Number(pointLimit);
      if (!Number.isFinite(pointLimitNum) || pointLimit.trim().length === 0) {
        setError("Please enter the elimination points.");
        return;
      }
      if (pointLimitNum < 1 || pointLimitNum > 200) {
        setError("Elimination points must be between 1 and 200.");
        return;
      }

      await api<EventState>(`/events/${session.eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ pointLimit: pointLimitNum, lanes: lanesNum, theme, weightUnit }),
      });
      navigate(`/events/${session.eventId}/scouts`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const claimEvent = async () => {
    if (!session?.eventId) return;
    try {
      await api(`/events/${session.eventId}/claim`, { method: "POST" });
      removeLocalGuestEventId(session.eventId);
      const updated = await api<EventState>(`/events/${session.eventId}`);
      setEvent(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!session || !event) return <main className="home-page"><p>{error || "Loading setup..."}</p></main>;

  return (
    <main className="home-page">
      <h1>Configure Event</h1>
      <p className="muted">Setup your tournament parameters.</p>
      {event.isGuest && !user && (
        <div className="banner info desktop-only">
          This is a guest event. <Link to="/login">Login</Link> or <Link to="/signup">Signup</Link> to save it to your account.
        </div>
      )}
      {event.isGuest && user && (
        <div className="banner info desktop-only">
          This is a guest event. <button onClick={claimEvent} className="text-btn">Save to my account</button>
        </div>
      )}
      <div className="wizard-steps">
        <div className={`wizard-step ${step === 1 ? "active" : step > 1 ? "completed" : ""}`}>1. Theme</div>
        <div className={`wizard-step ${step === 2 ? "active" : step > 2 ? "completed" : ""}`}>2. Lanes</div>
        <div className={`wizard-step ${step === 3 ? "active" : step > 3 ? "completed" : ""}`}>3. Points</div>
      </div>

      <form className="card" onSubmit={saveAndNext}>
        {step === 1 && (
          <>
            <h2>Tournament Theme</h2>
            <p className="muted">Select a theme to continue.</p>
            <div className="unit-toggle">
              <button
                type="button"
                className={`secondary-btn ${weightUnit === "g" ? "active" : ""}`}
                onClick={() => setWeightUnit("g")}
              >
                grams
              </button>
              <button
                type="button"
                className={`secondary-btn ${weightUnit === "oz" ? "active" : ""}`}
                onClick={() => setWeightUnit("oz")}
              >
                ounces
              </button>
              <span className="muted">Weight unit</span>
            </div>
            <div className="theme-grid">
              <button
                type="button"
                className="theme-btn"
                data-theme="system"
                onClick={() => {
                  setTheme("system");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="system" />
                <div className="theme-title">System</div>
                <div className="theme-subtitle">System</div>
              </button>
              <button
                type="button"
                className="theme-btn"
                data-theme="scouts-au-cubs"
                onClick={() => {
                  setTheme("scouts-au-cubs");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="scouts-au-cubs" />
                <div className="theme-title">Cubs Australia</div>
                <div className="theme-subtitle">Cubs Australia</div>
              </button>
              <button
                type="button"
                className="theme-btn"
                data-theme="scouts-america"
                onClick={() => {
                  setTheme("scouts-america");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="scouts-america" />
                <div className="theme-title">BSA</div>
                <div className="theme-subtitle">BSA</div>
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>Track Lanes</h2>
            <p className="muted">Enter your track lane count.</p>
            <label>How many lanes does your track have?
              <input type="number" min={2} max={12} value={lanes} onChange={(e) => setLanes(e.target.value)} autoFocus />
            </label>
          </>
        )}
        {step === 3 && (
          <>
            <h2>Elimination Points</h2>
            <p className="muted">Lower numbers eliminate racers faster.</p>
            <label>How many points before a racer is eliminated?
              <input type="number" min={1} max={200} value={pointLimit} onChange={(e) => setPointLimit(e.target.value)} autoFocus />
            </label>
          </>
        )}

        {step > 1 ? (
          <div className="wizard-actions">
            <button type="button" className="secondary-btn" onClick={() => setStep(step - 1)}>Back</button>
            <div style={{ flex: 1 }} />
            <button type="submit">{step === 3 ? "Continue to contestants" : "Next"}</button>
          </div>
        ) : null}
      </form>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

function AddScoutsPage() {
  const navigate = useNavigate();
  const { eventId } = useParams();
  const { user } = useAuth();
  const { event, error: eventError } = useEvent(eventId);
  const [scoutName, setScoutName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [weight, setWeight] = useState("");
  const [error, setError] = useState("");
  const [patrols, setPatrols] = useState<RacePatrol[]>([]);
  const [patrolLoading, setPatrolLoading] = useState(false);
  const [patrolError, setPatrolError] = useState("");
  const [selectedPatrolIds, setSelectedPatrolIds] = useState<string[]>([]);
  const [importingPatrols, setImportingPatrols] = useState(false);

  const addScout = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    try {
      const weightValue = weight.trim().length > 0 ? Number(weight) : undefined;
      await api(`/events/${eventId}/scouts`, {
        method: "POST",
        body: JSON.stringify({
          name: scoutName,
          groupName: groupName.trim().length > 0 ? groupName.trim() : undefined,
          weight: Number.isFinite(weightValue as number) ? weightValue : undefined,
        }),
      });
      setScoutName("");
      setGroupName("");
      setWeight("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!user) return;
    setPatrolLoading(true);
    setPatrolError("");
    api<RacePatrolListResponse>("/patrols")
      .then((res) => setPatrols(res.patrols))
      .catch((e: Error) => setPatrolError(e.message))
      .finally(() => setPatrolLoading(false));
  }, [user]);

  const togglePatrol = (patrolId: string) => {
    setSelectedPatrolIds((prev) => (prev.includes(patrolId) ? prev.filter((id) => id !== patrolId) : [...prev, patrolId]));
  };

  const importSelectedPatrols = async () => {
    if (!eventId) return;
    if (selectedPatrolIds.length === 0) return;
    setImportingPatrols(true);
    setError("");
    try {
      await api(`/events/${eventId}/scouts/import-patrols`, {
        method: "POST",
        body: JSON.stringify({ patrolIds: selectedPatrolIds }),
      });
      setSelectedPatrolIds([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImportingPatrols(false);
    }
  };

  const finishSetup = async () => {
    if (!eventId) return;
    try {
      await api<EventState>(`/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ setupComplete: true }),
      });
      navigate(`/control/${eventId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (eventError) {
    if (isAuthRequiredError(eventError)) return <AuthRequiredPage message={eventError} />;
    return <main className="home-page"><p className="error">{eventError}</p></main>;
  }
  if (!event) return <main className="home-page"><p>Loading racers...</p></main>;

  return (
    <main className="home-page">
      <h1>Add Racers</h1>
      <form className="card" onSubmit={addScout}>
        <h2>Add Racer</h2>
        <label>Racer<input value={scoutName} onChange={(e) => setScoutName(e.target.value)} required /></label>
        <label>Group / Patrol / Den (optional)<input value={groupName} onChange={(e) => setGroupName(e.target.value)} /></label>
        <label>Weight ({event.weightUnit === "oz" ? "oz" : "g"}) (optional)<input type="number" step="any" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
        <button type="submit">Add racer</button>
      </form>

      {user ? (
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
            <h2>Race Patrols</h2>
            <Link to="/patrols" className="link-btn">Manage patrols</Link>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Select one or more patrols to add all racers at once. The next block of car numbers is reserved, then randomly assigned within that block.
          </p>
          {patrolLoading ? <p className="muted">Loading patrols…</p> : null}
          {patrolError ? <p className="error">{patrolError}</p> : null}
          {!patrolLoading && patrols.length === 0 ? <p className="muted">No patrols yet.</p> : null}
          {patrols.length > 0 ? (
            <div className="stack" style={{ gap: "0.5rem" }}>
              {patrols.map((p) => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontWeight: 700 }}>
                  <input
                    type="checkbox"
                    checked={selectedPatrolIds.includes(p.id)}
                    onChange={() => togglePatrol(p.id)}
                    style={{ width: "1.1rem", height: "1.1rem" }}
                  />
                  <span style={{ flex: 1 }}>
                    {p.name} <span className="muted">({p.racers.length} racer{p.racers.length === 1 ? "" : "s"})</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="wizard-actions" style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setSelectedPatrolIds([])}
              disabled={selectedPatrolIds.length === 0 || importingPatrols}
            >
              Clear
            </button>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void importSelectedPatrols()}
              disabled={selectedPatrolIds.length === 0 || importingPatrols}
            >
              {importingPatrols ? "Adding…" : `Add ${selectedPatrolIds.length} patrol${selectedPatrolIds.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2>Current Entry List ({event.scouts.length})</h2>
        <ul className="standings">
          {event.scouts.map((s) => (
            <li key={s.id}>
              <span>
                <strong>#{s.carNumber}</strong> {s.name}
                {s.groupName ? <span className="muted"> ({s.groupName})</span> : null}
                {typeof s.weight === "number" ? (
                  <span className="muted"> • {s.weight}{event.weightUnit === "oz" ? "oz" : "g"}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {event.scouts.length === 0 && <p className="muted">No racers added yet.</p>}
      </section>

      <div className="wizard-actions">
        <button className="secondary-btn" onClick={() => navigate(-1)}>Back to settings</button>
        <div style={{ flex: 1 }} />
        <button onClick={finishSetup} disabled={event.scouts.length < 2}>
          {event.scouts.length < 2 ? "Add at least 2 racers" : "Start Race Control"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

function RaceControlPage() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const { event, error, setEvent } = useEvent(eventId);
  const [submitError, setSubmitError] = useState("");
  const currentHeat = useMemo(() => event?.heats?.find((h) => h.id === event.currentHeatId), [event]);
  const scoutById = useMemo(() => new Map((event?.scouts ?? []).map((s) => [s.id, s])), [event?.scouts]);
  const [finishOrder, setFinishOrder] = useState<string[]>([]);
  const [showLateEntrant, setShowLateEntrant] = useState(false);
  const [lateName, setLateName] = useState("");
  const [lateGroup, setLateGroup] = useState("");
  const [lateWeight, setLateWeight] = useState("");
  const [latePenalty, setLatePenalty] = useState("");
  const [lateError, setLateError] = useState("");
  const [lateSaving, setLateSaving] = useState(false);
  const [popularVote, setPopularVote] = useState<{
    completedAt: number | null;
    totalVotes: number;
    revealAt: number | null;
    revealCountdownSeconds: number;
    winner: Scout | null;
    ranks: Array<{ scout: Scout; votes: number }>;
  } | null>(null);
  const [popularLoading, setPopularLoading] = useState(false);
  const [popularError, setPopularError] = useState("");
  const [popularSubmitting, setPopularSubmitting] = useState(false);

  useEffect(() => {
    setFinishOrder([]);
  }, [currentHeat?.id]);

  useEffect(() => {
    if (!showLateEntrant) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowLateEntrant(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showLateEntrant]);

  const refreshPopularVote = useCallback(async () => {
    if (!event?.id) return;
    setPopularLoading(true);
    setPopularError("");
    try {
      const data = await api<{
        completedAt: number | null;
        totalVotes: number;
        revealAt: number | null;
        revealCountdownSeconds: number;
        winner: Scout | null;
        ranks: Array<{ scout: Scout; votes: number }>;
      }>(`/events/${event.id}/popular-vote`);
      setPopularVote(data);
    } catch (e) {
      setPopularError((e as Error).message);
    } finally {
      setPopularLoading(false);
    }
  }, [event?.id]);

  useEffect(() => {
    if (!event?.championScoutId) return;
    void refreshPopularVote();
  }, [event?.championScoutId, refreshPopularVote]);

  const ordinal = (n: number) => {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    const mod10 = n % 10;
    if (mod10 === 1) return `${n}st`;
    if (mod10 === 2) return `${n}nd`;
    if (mod10 === 3) return `${n}rd`;
    return `${n}th`;
  };

  const generateHeat = async () => {
    if (!event) return;
    try {
      await api(`/events/${event.id}/next-heat`, { method: "POST" });
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  };

  const remainingFinishers = useMemo(() => {
    if (!currentHeat) return [];
    const picked = new Set(finishOrder);
    return currentHeat.laneAssignments.filter((id) => !picked.has(id));
  }, [currentHeat, finishOrder]);

  const popularVoteCandidates = useMemo(() => {
    if (!event) return [];
    return [...event.scouts].sort((a, b) => {
      const aNum = Number.parseInt(a.carNumber, 10);
      const bNum = Number.parseInt(b.carNumber, 10);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
      return a.name.localeCompare(b.name);
    });
  }, [event]);

  const selectFinisher = (scoutId: string) => {
    if (!currentHeat) return;
    if (finishOrder.includes(scoutId)) return;
    setFinishOrder((prev) => [...prev, scoutId]);
  };

  const undoFinisher = () => {
    setFinishOrder((prev) => prev.slice(0, -1));
  };

  const submitHeatResult = async () => {
    if (!event || !currentHeat) return;
    if (finishOrder.length !== currentHeat.laneAssignments.length) return;

    try {
      await api(`/events/${event.id}/heats/${currentHeat.id}/result`, {
        method: "POST",
        body: JSON.stringify({ finishOrder }),
      });
      setFinishOrder([]);
      if (!event.isComplete) {
        await generateHeat().catch(() => undefined);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  };

  const claimEvent = async () => {
    if (!eventId) return;
    try {
      await api(`/events/${eventId}/claim`, { method: "POST" });
      removeLocalGuestEventId(eventId);
      const updated = await api<EventState>(`/events/${eventId}`);
      setEvent(updated);
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  };

  const dropRacer = async (scoutId: string) => {
    if (!event) return;
    const scout = scoutById.get(scoutId);
    if (!scout) return;
    if (scout.eliminated) return;
    if (!window.confirm(`Drop #${scout.carNumber} ${scout.name} from this race?\n\nThey will be ranked based on when they dropped.`)) {
      return;
    }
    try {
      await api(`/events/${event.id}/scouts/${scoutId}/drop`, { method: "POST" });
      setSubmitError("");
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  };

  const addLateEntrant = async (e: FormEvent) => {
    e.preventDefault();
    if (!event) return;
    if (!lateName.trim()) return;

    const weightValue = lateWeight.trim().length > 0 ? Number(lateWeight) : undefined;
    const penaltyValue = latePenalty.trim().length > 0 ? Number(latePenalty) : undefined;

    if (lateWeight.trim().length > 0 && !Number.isFinite(weightValue as number)) {
      setLateError("Weight must be a number.");
      return;
    }
    if (latePenalty.trim().length > 0 && (!Number.isFinite(penaltyValue as number) || (penaltyValue as number) < 0)) {
      setLateError("Points penalty must be a positive number.");
      return;
    }
    if (latePenalty.trim().length > 0 && !Number.isInteger(penaltyValue as number)) {
      setLateError("Points penalty must be a whole number.");
      return;
    }

    setLateSaving(true);
    setLateError("");
    try {
      await api(`/events/${event.id}/scouts`, {
        method: "POST",
        body: JSON.stringify({
          name: lateName.trim(),
          groupName: lateGroup.trim().length > 0 ? lateGroup.trim() : undefined,
          weight: Number.isFinite(weightValue as number) ? weightValue : undefined,
          pointsPenalty: Number.isFinite(penaltyValue as number) ? penaltyValue : undefined,
        }),
      });
      setLateName("");
      setLateGroup("");
      setLateWeight("");
      setLatePenalty("");
      setShowLateEntrant(false);
    } catch (err) {
      setLateError((err as Error).message);
    } finally {
      setLateSaving(false);
    }
  };

  const submitPopularVote = async (favoriteScoutId: string) => {
    if (!event) return;
    setPopularSubmitting(true);
    setPopularError("");
    try {
      await api(`/events/${event.id}/popular-vote`, {
        method: "POST",
        body: JSON.stringify({ favoriteScoutId }),
      });
      await refreshPopularVote();
    } catch (e) {
      setPopularError((e as Error).message);
    } finally {
      setPopularSubmitting(false);
    }
  };

  const revealPopularVote = async () => {
    if (!event) return;
    setPopularSubmitting(true);
    setPopularError("");
    try {
      await api(`/events/${event.id}/popular-vote/reveal`, { method: "POST" });
      await refreshPopularVote();
    } catch (e) {
      setPopularError((e as Error).message);
    } finally {
      setPopularSubmitting(false);
    }
  };

  if (!eventId) return <Navigate to="/" replace />;
  if (error) {
    if (isAuthRequiredError(error)) return <AuthRequiredPage message={error} />;
    return <main className="home-page"><p className="error">{error}</p></main>;
  }
  if (!event) return <main className="home-page"><p>Loading race control...</p></main>;

  return (
    <main className="operator-page">
      {event.isGuest && !user && (
        <div className="banner info desktop-only">
          This is a guest event. <Link to="/login">Login</Link> or <Link to="/signup">Signup</Link> to save it to your account.
        </div>
      )}
      {event.isGuest && user && (
        <div className="banner info desktop-only">
          This is a guest event. <button onClick={claimEvent} className="text-btn">Save to my account</button>
        </div>
      )}
      <header className="operator-header">
        <h1>{event.name}</h1>
        <p>Lanes: {event.lanes} | Elimination points: {event.pointLimit}</p>
        <div className="inline-actions">
          <button className="secondary-btn" onClick={() => { setShowLateEntrant(true); setLateError(""); }}>
            Add late entrant
          </button>
        </div>
      </header>
      <section className="card">
        <h2>Current Heat</h2>
        {currentHeat ? (
          <>
            <p className="muted">Select {ordinal(finishOrder.length + 1)} place</p>
            {finishOrder.length > 0 ? (
              <div className="card" style={{ padding: "1rem", background: "var(--bg-soft)" }}>
                <h3 style={{ margin: 0 }}>Selected Order</h3>
                <ol style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
                  {finishOrder.map((scoutId, index) => (
                    <li key={`${scoutId}-${index}`} style={{ margin: "0.35rem 0" }}>
                      {ordinal(index + 1)}: <strong>#{scoutById.get(scoutId)?.carNumber}</strong> {scoutById.get(scoutId)?.name}
                      {scoutById.get(scoutId)?.groupName ? <span className="muted"> ({scoutById.get(scoutId)?.groupName})</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="stack">
              {remainingFinishers.map((scoutId) => (
                <button key={scoutId} onClick={() => selectFinisher(scoutId)}>
                  <span className="scout-pick">
                    <span className="scout-pick-number">#{scoutById.get(scoutId)?.carNumber}</span>
                    <span className="scout-pick-name">{scoutById.get(scoutId)?.name}</span>
                    {scoutById.get(scoutId)?.groupName ? <span className="scout-pick-group">({scoutById.get(scoutId)?.groupName})</span> : null}
                  </span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button type="button" className="secondary-btn" onClick={undoFinisher} disabled={finishOrder.length === 0}>Undo</button>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={submitHeatResult} disabled={finishOrder.length !== currentHeat.laneAssignments.length}>Submit results</button>
            </div>
          </>
        ) : event.heats.length === 0 ? (
          <button onClick={generateHeat} disabled={event.isComplete}>Generate starting heat</button>
        ) : !event.isComplete ? (
          <p className="muted">Generating next heat...</p>
        ) : null}
      </section>
      <section className="card">
        <h2>Standings</h2>
        <ul className="standings">
          {event.standings.map((s) => (
            <li key={s.id} className={s.eliminated ? "eliminated" : ""}>
              <span><strong>#{s.carNumber}</strong> {s.name}{s.groupName ? <span className="muted"> ({s.groupName})</span> : null}</span>
              <span className="standings-right">
                <span>{s.eliminated ? (s.dropped ? "Dropped" : "Out") : `${s.points} point${s.points === 1 ? "" : "s"}`}</span>
                {!s.eliminated ? (
                  <button type="button" className="secondary-btn standings-drop" onClick={() => void dropRacer(s.id)}>
                    Drop
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {event.championScoutId ? (
        <section className="card success">
          <h2>Tournament Winner</h2>
          <p>{scoutById.get(event.championScoutId)?.name}</p>
          <Link to={`/results/${event.id}`} className="link-btn">View final results</Link>
        </section>
      ) : null}
      {event.championScoutId ? (
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
            <h2 style={{ margin: 0 }}>Popular Vote</h2>
            <div className="inline-actions">
              <button className="secondary-btn" onClick={() => void refreshPopularVote()} disabled={popularLoading}>
                Refresh
              </button>
              <button
                className="secondary-btn"
                onClick={() => void revealPopularVote()}
                disabled={popularSubmitting || !popularVote || Boolean(popularVote.revealAt)}
              >
                Reveal popular vote
              </button>
            </div>
          </div>
          {popularLoading ? <p className="muted">Loading votes…</p> : null}
          {popularError ? <p className="error">{popularError}</p> : null}
          {popularVote ? (
            <>
              {popularVote.revealAt ? (
                <>
                  <h3 style={{ margin: "0.5rem 0 0" }}>Winner</h3>
                  {popularVote.winner ? (
                    <p style={{ margin: 0 }}>
                      <strong>#{popularVote.winner.carNumber}</strong> {popularVote.winner.name}
                      {popularVote.winner.groupName ? <span className="muted"> ({popularVote.winner.groupName})</span> : null}
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>No votes recorded.</p>
                  )}
                  <p className="muted" style={{ margin: 0 }}>
                    {popularVote.totalVotes} vote{popularVote.totalVotes === 1 ? "" : "s"} cast
                  </p>
                  <details style={{ marginTop: "0.75rem" }}>
                    <summary>Show ranks</summary>
                    <ol style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
                      {popularVote.ranks.map((r) => (
                        <li key={r.scout.id}>
                          <strong>#{r.scout.carNumber}</strong> {r.scout.name}
                          {r.scout.groupName ? <span className="muted"> ({r.scout.groupName})</span> : null}
                          <span className="muted"> — {r.votes} vote{r.votes === 1 ? "" : "s"}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                </>
              ) : (
                <>
                  <p className="muted">Tap a car to cast a vote. Cast as many votes as you like, then reveal.</p>
                  <div className="stack">
                    {popularVoteCandidates.map((s) => (
                      <button key={s.id} onClick={() => void submitPopularVote(s.id)} disabled={popularSubmitting}>
                        <span className="scout-pick">
                          <span className="scout-pick-number">#{s.carNumber}</span>
                          <span className="scout-pick-name">{s.name}</span>
                          {s.groupName ? <span className="scout-pick-group">({s.groupName})</span> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="muted">No vote data yet.</p>
          )}
        </section>
      ) : null}
      {submitError ? <p className="error">{submitError}</p> : null}
      {showLateEntrant ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add late entrant">
          <section className="card modal-card">
            <button className="close-overlay" onClick={() => setShowLateEntrant(false)} aria-label="Close">×</button>
            <h2>Add Late Entrant</h2>
            <form onSubmit={addLateEntrant} className="stack">
              <label>Racer<input value={lateName} onChange={(e) => setLateName(e.target.value)} required autoFocus /></label>
              <label>Group / Patrol / Den (optional)<input value={lateGroup} onChange={(e) => setLateGroup(e.target.value)} /></label>
              <label>Weight ({event.weightUnit === "oz" ? "oz" : "g"}) (optional)<input type="number" step="any" value={lateWeight} onChange={(e) => setLateWeight(e.target.value)} /></label>
              <label>Points penalty (optional)<input type="number" min={0} step={1} value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} /></label>
              <div className="wizard-actions">
                <button type="button" className="secondary-btn" onClick={() => setShowLateEntrant(false)}>Cancel</button>
                <div style={{ flex: 1 }} />
                <button type="submit" disabled={lateSaving}>{lateSaving ? "Adding..." : "Add"}</button>
              </div>
            </form>
            {lateError ? <p className="error">{lateError}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function KioskPage() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { event, error, setEvent } = useEvent(eventId === "new" ? undefined : eventId);
  const [sessionToken, setSessionToken] = useState("");
  const [qrSrc, setQrSrc] = useState("");
  const [qrUrl, setQrUrl] = useState("");
  const [qrToken, setQrToken] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [showPairing, setShowPairing] = useState(true);
  const [newName, setNewName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [namingError, setNamingError] = useState("");
  const [previousWinner, setPreviousWinner] = useState<Scout | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);
  const [lastActiveHeatId, setLastActiveHeatId] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<"idle" | "copying" | "copied">("idle");
  const shareTimerRef = useRef<number | null>(null);
  const [pairingCopied, setPairingCopied] = useState<null | "code" | "url">(null);
  const pairingCopyTimerRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isNewEvent = eventId === "new" || (event?.name === "New Pinewood Derby Event" && !event?.setupComplete);
  const kioskTheme = (event?.theme as ThemeName | undefined) ?? "system";

  useEffect(() => {
    return () => {
      if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
      if (pairingCopyTimerRef.current) window.clearTimeout(pairingCopyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showPairing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPairing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showPairing]);

  useEffect(() => {
    if (!event?.popularVoteRevealAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [event?.popularVoteRevealAt]);

  const copyKioskLink = async () => {
    if (!event?.id) return;
    setShareStatus("copying");

    const base = getQrPrefix();
    let url = `${base}/kiosk/${event.id}`;
    if (user && !event.isGuest) {
      try {
        const res = await api<{ token: string; expiresAt: number }>(`/events/${event.id}/guest-kiosk-link`, { method: "POST" });
        url = `${base}/guest-kiosk/${res.token}`;
      } catch {
        void 0;
      }
    }

    await copyToClipboardWithFallback(url);

    setShareStatus("copied");
    if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
    shareTimerRef.current = window.setTimeout(() => setShareStatus("idle"), 1500);
  };

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    await copyToClipboardWithFallback(pairingCode);
    setPairingCopied("code");
    if (pairingCopyTimerRef.current) window.clearTimeout(pairingCopyTimerRef.current);
    pairingCopyTimerRef.current = window.setTimeout(() => setPairingCopied(null), 1500);
  };

  const copyPairingLink = async () => {
    if (!qrUrl) return;
    await copyToClipboardWithFallback(qrUrl);
    setPairingCopied("url");
    if (pairingCopyTimerRef.current) window.clearTimeout(pairingCopyTimerRef.current);
    pairingCopyTimerRef.current = window.setTimeout(() => setPairingCopied(null), 1500);
  };

  const claimEvent = async () => {
    if (!event?.id) return;
    try {
      await api(`/events/${event.id}/claim`, { method: "POST" });
      removeLocalGuestEventId(event.id);
      const updated = await api<EventState>(`/events/${event.id}`);
      setEvent(updated);
    } catch (err) {
      setNamingError((err as Error).message);
    }
  };

  const handleNameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const suggestedName =
      event?.name && event.name !== "New Pinewood Derby Event" ? event.name : "";
    const nameToSubmit = (nameTouched ? newName : suggestedName).trim();
    if (!nameToSubmit || !sessionToken) return;
    try {
      const res = await api<EventState>(`/kiosk/sessions/${sessionToken}/create-event`, {
        method: "POST",
        body: JSON.stringify({ name: nameToSubmit, lanes: 4, pointLimit: 10 }),
      });
      setEvent(res);
      if (!user || res.isGuest) addLocalGuestEventId(res.id);
      navigate(`/kiosk/${res.id}`, { replace: true });
      setNamingError("");
    } catch (err) {
      setNamingError((err as Error).message);
    }
  };

  useEffect(() => {
    const ensureSession = async () => {
      let token = window.localStorage.getItem(kioskSessionStorageKey);
      if (token) {
        try {
          const session = await api<KioskSessionStatus>(`/kiosk/sessions/${token}`);
          if (eventId !== "new" && session.eventId && session.eventId !== eventId) {
            token = null; // Bound to wrong event, reset.
          }
        } catch {
          token = null;
        }
      }

      if (!token) {
        const created = await api<{ token: string }>("/kiosk/sessions", { method: "POST" });
        token = created.token;
        window.localStorage.setItem(kioskSessionStorageKey, token);
      }

      setSessionToken(token);
      if (eventId !== "new") {
        await api(`/kiosk/sessions/${token}/bind`, { method: "POST", body: JSON.stringify({ eventId }) }).catch(() => undefined);
      }
    };

    ensureSession().catch((e: Error) => setSessionError(e.message));
  }, [eventId]);

  useEffect(() => {
    socket.on("kiosk:paired", () => setShowPairing(false));
    return () => {
      socket.off("kiosk:paired");
    };
  }, []);

  useEffect(() => {
    if (!sessionToken || isNewEvent || (eventId === "new")) return;

    const refreshPairing = () => {
      api<{ qrToken: string; pairingCode: string }>(`/kiosk/sessions/${sessionToken}/pairing-request`, {
        method: "POST",
      })
        .then((res) => {
          setQrToken(res.qrToken);
          setPairingCode(res.pairingCode);
          const url = `${getQrPrefix()}/pair/${res.qrToken}`;
          setQrUrl(url);
          return QRCode.toDataURL(url, { width: 320, margin: 1 });
        })
        .then(setQrSrc)
        .catch((e: Error) => setSessionError(`QR error: ${e.message}`));
    };

    refreshPairing();
    const interval = setInterval(refreshPairing, 110_000); // Refresh slightly before 2m expiry
    return () => clearInterval(interval);
  }, [sessionToken, eventId, isNewEvent]);

  const currentHeat = useMemo(() => event?.heats?.find((h) => h.id === event.currentHeatId), [event]);
  const scoutMap = useMemo(() => new Map((event?.scouts ?? []).map((s) => [s.id, s])), [event?.scouts]);

  useEffect(() => {
    if (!event) return;
    if (event.isComplete) return;
    
    // Check if the heat we were tracking just finished
    const justFinished = event.heats.find(h => h.id === lastActiveHeatId && h.winnerScoutId);
    if (justFinished && !showWinnerOverlay) {
      const winner = scoutMap.get(justFinished.winnerScoutId!);
      if (winner) {
        setPreviousWinner(winner);
        setShowWinnerOverlay(true);
        // Clear the tracked heat ID so we don't trigger again for the same heat
        setLastActiveHeatId(null);
      }
    }
    
    // Update tracking for the *next* active heat
    if (currentHeat?.id && currentHeat.id !== lastActiveHeatId && !showWinnerOverlay) {
      setLastActiveHeatId(currentHeat.id);
    }
  }, [event, currentHeat?.id, lastActiveHeatId, scoutMap, showWinnerOverlay]);

  useEffect(() => {
    if (showWinnerOverlay) {
      const timer = setTimeout(() => {
        setShowWinnerOverlay(false);
        setPreviousWinner(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [showWinnerOverlay]);

  if (!eventId) return <Navigate to="/" replace />;
  if (error || sessionError) {
    const message = error || sessionError;
    if (isAuthRequiredError(message)) return <AuthRequiredPage message={message} />;
    return <main className="kiosk-page"><p className="error">{message}</p></main>;
  }
  if (!event && eventId !== "new") return <main className="kiosk-page"><p>Loading kiosk...</p></main>;

  return (
    <main className="kiosk-page" data-kiosk-theme={kioskTheme}>
      <AppHeader onRelink={() => setShowPairing(true)} />
      
      {isNewEvent ? (
        <div className="kiosk-naming-overlay">
          <section className="card" style={{ position: "relative" }}>
            <button className="close-overlay" onClick={() => navigate(-1)} aria-label="Close">×</button>
            <h2>Welcome to Pinewood Derby</h2>
            <p>To get started, please give this event a name.</p>
            <form onSubmit={handleNameSubmit} className="stack">
              <label>
                Event Name
                <input 
                  value={nameTouched ? newName : (event?.name && event.name !== "New Pinewood Derby Event" ? event.name : "")}
                  onChange={(e) => {
                    setNameTouched(true);
                    setNewName(e.target.value);
                  }}
                  placeholder="e.g. Pack 123 Annual Race" 
                  required 
                  autoFocus 
                />
              </label>
              <button type="submit">Start Setup</button>
            </form>
            {namingError ? <p className="error">{namingError}</p> : null}
          </section>
        </div>
      ) : event ? (
        <>
          <section className="kiosk-board">
            <h1>{event.name}</h1>
            {event.isGuest && !user && (
              <div className="banner info desktop-only">
                This is a guest event. <Link to="/login">Login</Link> or <Link to="/signup">Signup</Link> to save it to your account.
              </div>
            )}
            {event.isGuest && user && (
              <div className="banner info desktop-only">
                This is a guest event. <button onClick={claimEvent} className="text-btn">Save to my account</button>
              </div>
            )}
            
            {!event.setupComplete ? (
              <div className="kiosk-configuring">
                <div className="configuring-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 14.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.22-1.12.53-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L3.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L3.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.41 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.22 1.12-.53 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"
                    />
                  </svg>
                </div>
                <h2>Configuring Event</h2>
                <p>Please wait while the operator finishes setup.</p>
              </div>
            ) : event.isComplete && event.championScoutId ? (
              <div className="kiosk-final">
                <div className="kiosk-final-hero">
                  <div className="kiosk-final-title">Final Standings</div>
                  <div className="kiosk-final-winner">
                    Champion:{" "}
                    <span className="kiosk-final-winner-name">
                      #{scoutMap.get(event.championScoutId)?.carNumber} {scoutMap.get(event.championScoutId)?.name}
                    </span>
                  </div>
                  {event.popularVoteRevealAt ? (
                    (() => {
                      const revealAt = event.popularVoteRevealAt ?? 0;
                      const countdownSeconds = event.popularVoteRevealCountdownSeconds ?? 10;
                      const revealEndMs = revealAt + countdownSeconds * 1000;
                      const remainingSeconds = Math.max(0, Math.ceil((revealEndMs - nowMs) / 1000));

                      if (remainingSeconds > 0) {
                        return (
                          <div className="kiosk-popular-countdown" aria-label="Popular vote countdown">
                            <div className="kiosk-popular-countdown-title">Popular Vote</div>
                            <div className="kiosk-popular-countdown-number">{remainingSeconds}</div>
                          </div>
                        );
                      }

                      return (
                        <div className="kiosk-final-popular">
                          Popular Vote:{" "}
                          <span className="kiosk-final-winner-name">
                            {event.popularVoteWinner
                              ? `#${event.popularVoteWinner.carNumber} ${event.popularVoteWinner.name}`
                              : "No votes"}
                          </span>
                        </div>
                      );
                    })()
                  ) : null}
                </div>
                <div className="kiosk-final-standings">
                  {event.standings.map((scout, index) => (
                    <div
                      key={scout.id}
                      className={`kiosk-final-row ${index < 3 ? `rank-${index + 1}` : ""}`}
                    >
                      <span className="kiosk-final-rank">{index + 1}</span>
                      <span className="kiosk-final-name">#{scout.carNumber} {scout.name}{scout.groupName ? ` (${scout.groupName})` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="kiosk-grid">
                <div className="kiosk-card kiosk-heat-primary">
                  {showWinnerOverlay && previousWinner ? (
                    <div className="kiosk-heat-winner">
                      <div className="winner-label">Heat Winner</div>
                      <div className="winner-number-large">#{previousWinner.carNumber}</div>
                      <div className="winner-name-large">{previousWinner.name}</div>
                      {previousWinner.groupName ? <div className="winner-group">{previousWinner.groupName}</div> : null}
                      <div className="winner-sub">Readying next heat...</div>
                    </div>
                  ) : (
                    <>
                      <h2>Current Heat</h2>
                      {!currentHeat ? <p>Waiting for next heat...</p> : null}
                      <div className="heat-lanes">
                        {currentHeat?.laneAssignments.map((scoutId, laneIndex) => (
                          <div key={scoutId} className="heat-lane">
                            <span className="lane-number">Lane {laneIndex + 1}</span>
                            <div className="lane-scout">
                              <div className="lane-scout-number">#{scoutMap.get(scoutId)?.carNumber}</div>
                              <div className="lane-scout-name">{scoutMap.get(scoutId)?.name}</div>
                              {scoutMap.get(scoutId)?.groupName ? (
                                <div className="lane-scout-group">{scoutMap.get(scoutId)?.groupName}</div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <div className="kiosk-card kiosk-standings-card">
                  <h2>Current Standings</h2>
                  <div className="kiosk-standings-list">
                    {event.standings.map((scout, index) => (
                      <div key={scout.id} className={`kiosk-standing-item ${scout.eliminated ? "eliminated" : ""}`}>
                        <span className="standing-rank">#{index + 1}</span>
                        <span className="standing-name">#{scout.carNumber} {scout.name}{scout.groupName ? ` (${scout.groupName})` : ""}</span>
                        <span className="standing-status">
                        {scout.eliminated ? (scout.dropped ? "Dropped" : "Out") : `${scout.points} point${scout.points === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
          {showPairing ? (
            <div className="kiosk-pairing-overlay">
              <button className="close-overlay" onClick={() => setShowPairing(false)} aria-label="Close pairing">×</button>
              <h2>Pair Operator</h2>
              {qrSrc ? <img src={qrSrc} alt="Scan to control event" /> : <p>Generating QR...</p>}
              {pairingCode ? (
                <div className="pairing-code-display">
                  <code>{pairingCode}</code>
                </div>
              ) : null}
              {qrUrl ? <div className="overlay-note" style={{ wordBreak: "break-all" }}>{qrUrl}</div> : null}
              <p className="overlay-note">Scan QR and enter code to link device</p>
              <div className="overlay-actions">
                <button type="button" className="secondary-btn" onClick={() => void copyPairingCode()} disabled={!pairingCode}>
                  {pairingCopied === "code" ? "✓ Copied code" : "Copy code"}
                </button>
                <button type="button" className="secondary-btn" onClick={() => void copyPairingLink()} disabled={!qrUrl}>
                  {pairingCopied === "url" ? "✓ Copied link" : "Copy link"}
                </button>
                <a href={`/pair/${qrToken}?code=${pairingCode}`} target="_blank" rel="noopener noreferrer" className="direct-link">
                  Open operator view on this device
                </a>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {event?.id ? (
        <button
          className={`kiosk-share-btn ${shareStatus === "copied" ? "copied" : ""}`}
          onClick={() => void copyKioskLink()}
          disabled={shareStatus === "copying"}
          aria-label="Copy kiosk link"
        >
          {shareStatus === "copied" ? (
            "✓ Link copied"
          ) : shareStatus === "copying" ? (
            "…"
          ) : (
            <>
              <span className="kiosk-share-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M10.59 13.41a1 1 0 0 1 0-1.41l3.3-3.3a3 3 0 0 1 4.24 4.24l-2.83 2.83a3.5 3.5 0 0 1-4.95 0 1 1 0 1 1 1.41-1.41 1.5 1.5 0 0 0 2.12 0l2.83-2.83a1 1 0 1 0-1.41-1.41l-3.3 3.3a1 1 0 0 1-1.41 0Z"
                  />
                  <path
                    fill="currentColor"
                    d="M13.41 10.59a1 1 0 0 1 0 1.41l-3.3 3.3a3 3 0 0 1-4.24-4.24l2.83-2.83a3.5 3.5 0 0 1 4.95 0 1 1 0 0 1-1.41 1.41 1.5 1.5 0 0 0-2.12 0L7.29 11.5a1 1 0 1 0 1.41 1.41l3.3-3.3a1 1 0 0 1 1.41 0Z"
                  />
                </svg>
              </span>
              Link
            </>
          )}
        </button>
      ) : null}
    </main>
  );
}

function EventsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [events, setEvents] = useState<EventState[]>([]);
  const [guestEvents, setGuestEvents] = useState<EventState[]>([]);
  const [guestAccessUrls, setGuestAccessUrls] = useState<Record<string, { url: string; expiresAt: number }>>(() => getStoredGuestAccessUrls());
  const [copiedGuestAccessEventId, setCopiedGuestAccessEventId] = useState<string | null>(null);
  const copiedGuestAccessTimerRef = useRef<number | null>(null);
  const [claimStatus, setClaimStatus] = useState<{ inProgress: boolean; remaining: number }>({ inProgress: false, remaining: 0 });
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [error, setError] = useState("");

  const loadEvents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await api<EventListResponse>("/events");
      setEvents(res.events);
      const allowedIds = new Set(res.events.map((e) => e.id));
      const stored = getStoredGuestAccessUrls();
      const pruned: Record<string, { url: string; expiresAt: number }> = {};
      for (const [eventId, value] of Object.entries(stored)) {
        if (!allowedIds.has(eventId)) continue;
        pruned[eventId] = value;
      }
      setGuestAccessUrls(pruned);
      setStoredGuestAccessUrls(pruned);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const loadGuestEvents = useCallback(async () => {
    if (user) return;
    setGuestLoading(true);
    try {
      const ids = getLocalGuestEventIds();
      const results = await Promise.allSettled(ids.map((id) => api<EventState>(`/events/${id}`)));
      const kept: EventState[] = [];
      const remainingIds: string[] = [];

      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          if (r.value.isGuest) {
            kept.push(r.value);
            remainingIds.push(ids[idx]);
          }
          return;
        }
        const message = (r.reason as Error | undefined)?.message ?? "";
        if (message.includes("Event not found")) return;
        if (isAuthRequiredError(message)) return;
        remainingIds.push(ids[idx]);
      });

      setGuestEvents(kept);
      if (remainingIds.length !== ids.length || remainingIds.some((id, idx) => id !== ids[idx])) {
        setLocalGuestEventIds(remainingIds);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuestLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadGuestEvents();
  }, [loadGuestEvents]);

  useEffect(() => {
    if (!user) {
      setClaimStatus({ inProgress: false, remaining: 0 });
      return;
    }
    const ids = getLocalGuestEventIds();
    if (ids.length > 0) setClaimStatus({ inProgress: true, remaining: ids.length });
  }, [user]);

  useEffect(() => {
    const onChanged = () => void loadGuestEvents();
    const onClaimed = () => void loadEvents();
    const onClaimStatus = (e: Event) => {
      const detail = (e as CustomEvent<{ inProgress?: unknown; remaining?: unknown }>).detail;
      const inProgress = typeof detail?.inProgress === "boolean" ? detail.inProgress : false;
      const remaining = typeof detail?.remaining === "number" ? detail.remaining : 0;
      setClaimStatus({ inProgress, remaining });
    };
    window.addEventListener("pinewood:guest-events-changed", onChanged);
    window.addEventListener("pinewood:guest-events-claimed", onClaimed);
    window.addEventListener(guestClaimStatusEventName, onClaimStatus as EventListener);
    return () => {
      window.removeEventListener("pinewood:guest-events-changed", onChanged);
      window.removeEventListener("pinewood:guest-events-claimed", onClaimed);
      window.removeEventListener(guestClaimStatusEventName, onClaimStatus as EventListener);
    };
  }, [loadGuestEvents, loadEvents]);

  const deleteEvent = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this event? This cannot be undone.")) return;
    try {
      await api(`/events/${id}`, { method: "DELETE" });
      loadEvents();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const generateGuestAccessUrl = async (id: string) => {
    try {
      const res = await api<{ token: string; expiresAt: number }>(`/events/${id}/guest-kiosk-link`, { method: "POST" });
      const url = `${window.location.origin}/guest-kiosk/${res.token}`;
      setGuestAccessUrls((prev) => {
        const next = { ...prev, [id]: { url, expiresAt: res.expiresAt } };
        setStoredGuestAccessUrls(next);
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyGuestAccessUrl = async (id: string) => {
    const url = guestAccessUrls[id]?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedGuestAccessEventId(id);
      if (copiedGuestAccessTimerRef.current) window.clearTimeout(copiedGuestAccessTimerRef.current);
      copiedGuestAccessTimerRef.current = window.setTimeout(() => setCopiedGuestAccessEventId(null), 1200);
    } catch {
      window.prompt("Copy this URL:", url);
    }
  };

  const revokeGuestAccessUrl = async (id: string) => {
    if (!window.confirm("Disable the Guest Access URL for this event? Any shared links will stop working immediately.")) return;
    try {
      await api(`/events/${id}/guest-kiosk-link`, { method: "DELETE" });
      setGuestAccessUrls((prev) => {
        const next = { ...prev };
        delete next[id];
        setStoredGuestAccessUrls(next);
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteGuestEvent = async (id: string) => {
    if (!window.confirm("Delete this guest event from this device? This cannot be undone.")) return;
    try {
      await api(`/events/${id}/guest`, { method: "DELETE" });
      removeLocalGuestEventId(id);
      setGuestEvents((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createNewEvent = async () => {
    try {
      const boot = await api<{ token: string }>("/kiosk/bootstrap", { method: "POST" });
      window.localStorage.setItem(kioskSessionStorageKey, boot.token);
      navigate("/kiosk/new");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    return () => {
      if (copiedGuestAccessTimerRef.current) window.clearTimeout(copiedGuestAccessTimerRef.current);
    };
  }, []);

  return (
    <main className="home-page">
      <AppHeader />
      {!user ? (
        <>
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h1>Guest Events (This Device)</h1>
                <p className="muted">These events are stored locally and can be claimed when you log in.</p>
              </div>
              <div className="inline-actions">
                <button onClick={createNewEvent}>Create guest event</button>
              </div>
            </div>
            {guestLoading ? <p>Loading guest events...</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </section>

          <section className="card">
            <h2>Local Guest Events</h2>
            {guestEvents.length === 0 ? <p>No guest events found on this device.</p> : null}
            <div className="event-list">
              {guestEvents.map((event) => (
                <div key={event.id} className="event-item card">
                  <button
                    className="danger-btn corner-delete-btn"
                    onClick={() => deleteGuestEvent(event.id)}
                    aria-label="Delete event"
                    title="Delete event"
                  >
                    🗑
                  </button>
                  <div className="event-info">
                    <h3>{event.name}</h3>
                    <div className="event-meta">
                      <span className={`status-badge ${event.isComplete ? "finished" : event.setupComplete ? "in-progress" : "setup"}`}>
                        {event.isComplete ? "Finished" : event.setupComplete ? "In progress" : "Setup"}
                      </span>
                      <span><strong>{event.scouts.length}</strong> Racers</span>
                      <span><strong>{event.lanes}</strong> Lanes</span>
                    </div>
                  </div>
                  <div className="inline-actions">
                    {!event.isComplete ? (
                      <button className="secondary-btn" onClick={() => navigate(`/kiosk/${event.id}`)}>Kiosk</button>
                    ) : (
                      <button className="secondary-btn" onClick={() => navigate(`/results/${event.id}`)}>Results</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {user && (
        <>
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h1>My Events</h1>
              <div className="inline-actions">
                <button onClick={createNewEvent}>Create new event</button>
                <button className="secondary-btn" onClick={loadEvents}>Refresh</button>
              </div>
            </div>
            {claimStatus.inProgress ? (
              <div className="claiming-banner">
                <span className="inline-spinner" aria-hidden="true" />
                <span>Claiming local events{claimStatus.remaining > 0 ? ` (${claimStatus.remaining})` : ""}…</span>
              </div>
            ) : null}
            {loading ? <p>Loading events...</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </section>

          <section className="card">
            <h2>Existing Events</h2>
            {events.length === 0 ? <p>No events found yet.</p> : null}
            <div className="event-list my-events-list">
              {events.map((event) => (
                <div key={event.id} className="event-item card">
                  <button
                    className="danger-btn corner-delete-btn"
                    onClick={() => deleteEvent(event.id)}
                    aria-label="Delete event"
                    title="Delete event"
                  >
                    🗑
                  </button>
                  <div className="event-info">
                    <h3>{event.name}</h3>
                    <div className="event-meta">
                      <span className={`status-badge ${event.isComplete ? "finished" : event.setupComplete ? "in-progress" : "setup"}`}>
                        {event.isComplete ? "Finished" : event.setupComplete ? "In progress" : "Setup"}
                      </span>
                      <span><strong>{event.scouts.length}</strong> Racers</span>
                      <span><strong>{event.lanes}</strong> Lanes</span>
                    </div>
                  </div>
                  <div className="inline-actions">
                    {!event.isComplete ? (
                      <button className="secondary-btn" onClick={() => navigate(`/kiosk/${event.id}`)}>Kiosk</button>
                    ) : (
                      <button className="secondary-btn" onClick={() => navigate(`/results/${event.id}`)}>Results</button>
                    )}
                    {guestAccessUrls[event.id] ? (
                      <div className="guest-access-inline" role="group" aria-label="Guest access URL">
                        <div className="guest-access-url">{guestAccessUrls[event.id].url}</div>
                        <button
                          className={`secondary-btn guest-access-copy ${copiedGuestAccessEventId === event.id ? "copied" : ""}`}
                          onClick={() => void copyGuestAccessUrl(event.id)}
                          aria-label={copiedGuestAccessEventId === event.id ? "Copied" : "Copy guest access URL"}
                        >
                          {copiedGuestAccessEventId === event.id ? "✓" : "⧉"}
                        </button>
                        <button className="danger-btn guest-access-remove" onClick={() => void revokeGuestAccessUrl(event.id)} aria-label="Disable guest access URL">×</button>
                      </div>
                    ) : (
                      <button className="secondary-btn" onClick={() => generateGuestAccessUrl(event.id)}>Generate Guest Access URL</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function RacePatrolsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [patrols, setPatrols] = useState<RacePatrol[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [patrolName, setPatrolName] = useState("");
  const [racers, setRacers] = useState<Array<{ id: string; name: string; groupName: string; weight: string }>>([]);
  const [saving, setSaving] = useState(false);

  const loadPatrols = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const res = await api<RacePatrolListResponse>("/patrols");
      setPatrols(res.patrols);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadPatrols();
  }, [loadPatrols]);

  if (!user) return <AuthRequiredPage message="Login to manage Race Patrols." />;

  const openNew = () => {
    setEditingId(null);
    setPatrolName("");
    setRacers([{ id: crypto.randomUUID(), name: "", groupName: "", weight: "" }]);
    setEditorOpen(true);
    setError("");
  };

  const openEdit = (patrol: RacePatrol) => {
    setEditingId(patrol.id);
    setPatrolName(patrol.name);
    setRacers(
      patrol.racers.map((r) => ({
        id: r.id,
        name: r.name,
        groupName: r.groupName ?? "",
        weight: typeof r.weight === "number" ? String(r.weight) : "",
      }))
    );
    setEditorOpen(true);
    setError("");
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setSaving(false);
  };

  const save = async () => {
    const trimmedName = patrolName.trim();
    const normalizedRacers = racers
      .map((r) => ({
        name: r.name.trim(),
        groupName: r.groupName.trim(),
        weight: r.weight.trim(),
      }))
      .filter((r) => r.name.length > 0);

    if (trimmedName.length === 0) {
      setError("Please enter a patrol name.");
      return;
    }
    if (normalizedRacers.length === 0) {
      setError("Please add at least one racer.");
      return;
    }

    const payload = {
      name: trimmedName,
      racers: normalizedRacers.map((r) => {
        const weightValue = r.weight.length > 0 ? Number(r.weight) : undefined;
        return {
          name: r.name,
          groupName: r.groupName.length > 0 ? r.groupName : undefined,
          weight: Number.isFinite(weightValue as number) ? weightValue : undefined,
        };
      }),
    };

    setSaving(true);
    setError("");
    try {
      if (editingId) {
        await api(`/patrols/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/patrols`, { method: "POST", body: JSON.stringify(payload) });
      }
      closeEditor();
      await loadPatrols();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deletePatrol = async (id: string) => {
    if (!window.confirm("Delete this Race Patrol? This cannot be undone.")) return;
    setError("");
    try {
      await api(`/patrols/${id}`, { method: "DELETE" });
      await loadPatrols();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
          <div>
            <h1>Race Patrols</h1>
            <p className="muted">Create reusable racer groups you can add to events in one action.</p>
          </div>
          <div className="inline-actions">
            <button onClick={openNew}>New patrol</button>
            <button className="secondary-btn" onClick={() => navigate("/events")}>Back to events</button>
          </div>
        </div>
        {loading ? <p className="muted">Loading patrols…</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="card">
        <h2>Your Patrols</h2>
        {patrols.length === 0 ? <p className="muted">No patrols yet.</p> : null}
        <div className="event-list">
          {patrols.map((p) => (
            <div key={p.id} className="event-item card" style={{ gap: "0.5rem" }}>
              <div className="event-info">
                <h3 style={{ margin: 0 }}>{p.name}</h3>
                <div className="muted">{p.racers.length} racer{p.racers.length === 1 ? "" : "s"}</div>
              </div>
              <div className="inline-actions">
                <button className="secondary-btn" onClick={() => openEdit(p)}>Edit</button>
                <button className="danger-btn" onClick={() => void deletePatrol(p.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {editorOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Edit race patrol">
          <section className="card modal-card">
            <button className="close-overlay" onClick={closeEditor} aria-label="Close">×</button>
            <h2>{editingId ? "Edit Patrol" : "New Patrol"}</h2>
            <div className="stack">
              <label>
                Patrol name
                <input value={patrolName} onChange={(e) => setPatrolName(e.target.value)} autoFocus required />
              </label>
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <div style={{ fontWeight: 800 }}>Racers</div>
                {racers.map((r) => (
                  <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px auto", gap: "0.5rem", alignItems: "end" }}>
                    <label style={{ margin: 0 }}>
                      Name
                      <input
                        value={r.name}
                        onChange={(e) => setRacers((prev) => prev.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                        required
                      />
                    </label>
                    <label style={{ margin: 0 }}>
                      Group (optional)
                      <input
                        value={r.groupName}
                        onChange={(e) => setRacers((prev) => prev.map((x) => (x.id === r.id ? { ...x, groupName: e.target.value } : x)))}
                      />
                    </label>
                    <label style={{ margin: 0 }}>
                      Weight
                      <input
                        type="number"
                        step="any"
                        value={r.weight}
                        onChange={(e) => setRacers((prev) => prev.map((x) => (x.id === r.id ? { ...x, weight: e.target.value } : x)))}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => setRacers((prev) => prev.filter((x) => x.id !== r.id))}
                      disabled={racers.length <= 1}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setRacers((prev) => [...prev, { id: crypto.randomUUID(), name: "", groupName: "", weight: "" }])}
                >
                  Add racer
                </button>
              </div>
              <div className="wizard-actions">
                <button type="button" className="secondary-btn" onClick={closeEditor} disabled={saving}>Cancel</button>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => void save()} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              {error ? <p className="error">{error}</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function GuestKioskRedeemPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    api<{ token: string; eventId: string | null; expiresAt: number }>(`/guest-kiosk/${token}`, { method: "POST" })
      .then((res) => {
        window.localStorage.setItem(kioskSessionStorageKey, res.token);
        if (!res.eventId) throw new Error("No event linked to this access token");
        navigate(`/kiosk/${res.eventId}`, { replace: true });
      })
      .catch((e: Error) => setError(e.message));
  }, [token, navigate]);

  return (
    <main className="home-page auth-required-page">
      <section className="card auth-required-card">
        <h1>Opening Guest Kiosk…</h1>
        {error ? <p className="error">{error}</p> : <p className="muted">Please wait.</p>}
        <div className="auth-required-actions">
          <button className="secondary-btn" onClick={() => navigate("/")}>Home</button>
        </div>
      </section>
    </main>
  );
}

function PairingPage() {
  const { qrToken } = useParams();
  const navigate = useNavigate();
  const [pairingCode, setPairingCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (codeToUse?: string) => {
    const code = codeToUse ?? pairingCode;
    if (!qrToken || code.length !== 6) return;
    setLoading(true);
    setError("");

    try {
      const res = await api<{ token: string; eventId: string | null }>("/kiosk/pair", {
        method: "POST",
        body: JSON.stringify({ qrToken, pairingCode: code }),
      });

      window.localStorage.setItem(kioskSessionStorageKey, res.token);
      if (res.eventId) {
        // If event is already setup, go to control, otherwise configure.
        const event = await api<EventState>(`/events/${res.eventId}`);
        if (event.setupComplete) {
          navigate(`/control/${res.eventId}`);
        } else {
          navigate(`/configure/${res.token}`);
        }
      } else {
        navigate("/events");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [qrToken, pairingCode, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && code.length === 6 && qrToken) {
      setPairingCode(code);
      void handleSubmit(code);
    }
  }, [qrToken, handleSubmit]);

  useEffect(() => {
    if (pairingCode.length === 6) {
      void handleSubmit();
    }
  }, [pairingCode, handleSubmit]);

  return (
    <main className="home-page">
      <section className="card">
        <h1>Pair with Kiosk</h1>
        <p>Enter the 6-digit code displayed on the kiosk screen.</p>
        <form onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }} className="stack">
          <label>
            Pairing Code
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              autoFocus
              required
              disabled={loading}
              className="pairing-input"
            />
          </label>
          {loading && <p className="muted" style={{ textAlign: "center" }}>Linking device...</p>}
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

function ResultsPage() {
  const { eventId } = useParams();
  const [results, setResults] = useState<EventResults | null>(null);
  const [error, setError] = useState("");

  const heatResultsSorted = useMemo(() => {
    if (!results) return [];
    return [...results.heatResults].sort((a, b) => a.createdAt - b.createdAt);
  }, [results]);

  const pointsAfterByHeatId = useMemo(() => {
    if (!results) return new Map<string, Map<string, number>>();
    const finalPointsById = new Map(results.event.scouts.map((s) => [s.id, s.points]));
    const gainedById = new Map<string, number>();
    heatResultsSorted.forEach((heat) => {
      heat.placements.forEach((p) => {
        const id = p.scout?.id;
        if (!id) return;
        gainedById.set(id, (gainedById.get(id) ?? 0) + (p.place - 1));
      });
    });

    const currentPoints = new Map<string, number>();
    results.event.scouts.forEach((s) => {
      const final = finalPointsById.get(s.id) ?? 0;
      const gained = gainedById.get(s.id) ?? 0;
      currentPoints.set(s.id, final - gained);
    });

    const out = new Map<string, Map<string, number>>();
    heatResultsSorted.forEach((heat) => {
      heat.placements.forEach((p) => {
        const id = p.scout?.id;
        if (!id) return;
        currentPoints.set(id, (currentPoints.get(id) ?? 0) + (p.place - 1));
      });
      const snapshot = new Map<string, number>();
      heat.placements.forEach((p) => {
        const id = p.scout?.id;
        if (!id) return;
        snapshot.set(id, currentPoints.get(id) ?? 0);
      });
      out.set(heat.id, snapshot);
    });

    return out;
  }, [heatResultsSorted, results]);

  useEffect(() => {
    if (!eventId) return;
    api<EventResults>(`/events/${eventId}/results`)
      .then(setResults)
      .catch((e: Error) => setError(e.message));
  }, [eventId]);

  if (!eventId) return <Navigate to="/" replace />;
  if (error) {
    if (isAuthRequiredError(error)) return <AuthRequiredPage message={error} />;
    return <main className="home-page"><p className="error">{error}</p></main>;
  }
  if (!results) return <main className="home-page"><p>Loading results...</p></main>;

  return (
    <main className="home-page">
      <AppHeader />
      <div className="results-container">
        <section className="card success results-hero">
          <div className="champion-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M6 2h12v2h3v4c0 3.3-2.7 6-6 6h-.2A6.02 6.02 0 0 1 13 15.66V18h4v2H7v-2h4v-2.34A6.02 6.02 0 0 1 9.2 14H9c-3.3 0-6-2.7-6-6V4h3V2Zm2 2v7c0 2.2 1.8 4 4 4s4-1.8 4-4V4H8Zm11 2h-1v5.1c1.2-.6 2-1.9 2-3.4V6ZM6 11.1V6H5v1.7c0 1.5.8 2.8 2 3.4Z"
              />
            </svg>
          </div>
          <h1>{results.event.name}</h1>
          <div className="champion-name">
            Champion:{" "}
            <strong>
              {results.champion ? `#${results.champion.carNumber} ${results.champion.name}` : "TBD"}
            </strong>
          </div>
          <div className="event-stats">
            <span><strong>{results.heatResults.length}</strong> Heats</span>
            <span><strong>{results.event.scouts.length}</strong> Racers</span>
          </div>
        </section>

        <section className="card">
          <h2>Popular Vote</h2>
          {!results.popularVote.revealAt ? (
            <>
              <p className="muted" style={{ margin: 0 }}>Not revealed yet.</p>
              <p className="muted" style={{ margin: 0 }}>{results.popularVote.totalVotes} vote{results.popularVote.totalVotes === 1 ? "" : "s"} cast</p>
            </>
          ) : results.popularVote.totalVotes === 0 ? (
            <p className="muted">No votes recorded.</p>
          ) : (
            <>
              <p style={{ margin: 0 }}>
                Winner:{" "}
                <strong>
                  {results.popularVote.winner ? `#${results.popularVote.winner.carNumber} ${results.popularVote.winner.name}` : "TBD"}
                </strong>
                {results.popularVote.winner?.groupName ? <span className="muted"> ({results.popularVote.winner.groupName})</span> : null}
              </p>
              <p className="muted" style={{ margin: 0 }}>
                {results.popularVote.totalVotes} vote{results.popularVote.totalVotes === 1 ? "" : "s"} cast
              </p>
              <details style={{ marginTop: "0.5rem" }}>
                <summary>Show ranks</summary>
                <ol style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
                  {results.popularVote.ranks.map((r) => (
                    <li key={r.scout.id}>
                      <strong>#{r.scout.carNumber}</strong> {r.scout.name}
                      {r.scout.groupName ? <span className="muted"> ({r.scout.groupName})</span> : null}
                      <span className="muted"> — {r.votes} vote{r.votes === 1 ? "" : "s"}</span>
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </section>

        <section className="card">
          <h2>Final Standings</h2>
          <div className="standings-grid">
            {results.event.standings.map((scout, index) => (
              <div key={scout.id} className={`standings-item ${index < 3 ? `rank-${index + 1}` : ""}`}>
                <span className="rank">{index + 1}</span>
                <span className="scout-name">
                  <strong>#{scout.carNumber}</strong> {scout.name}
                  {scout.groupName ? <span className="muted"> ({scout.groupName})</span> : null}
                </span>
                <span className="car-number">{scout.eliminated ? (scout.dropped ? "Dropped" : "Out") : ""}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Race History</h2>
          {heatResultsSorted.length === 0 ? <p className="muted">No races recorded yet.</p> : null}
          <div className="race-history">
            {(() => {
              const events = (results.timeline ?? [])
                .filter((t) => typeof t?.createdAt === "number")
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt);
              let cursor = -Infinity;
              const out: ReactNode[] = [];
              for (let i = 0; i < heatResultsSorted.length; i += 1) {
                const heat = heatResultsSorted[i];
                const between = events.filter((t) => t.createdAt > cursor && t.createdAt <= heat.createdAt);
                between.forEach((t) => {
                  const scout = t.scoutId ? results.event.scouts.find((s) => s.id === t.scoutId) ?? null : null;
                  if (t.type === "late_entrant") {
                    out.push(
                      <div key={t.id} className="race-history-event">
                        <div className="race-history-event-line" />
                        <div className="race-history-event-text">
                          Late entrant added:{" "}
                          {scout ? (
                            <strong>#{scout.carNumber} {scout.name}</strong>
                          ) : (
                            <strong>Unknown</strong>
                          )}
                          {typeof t.pointsPenalty === "number" ? (
                            <span className="muted"> — {t.pointsPenalty} pt penalty</span>
                          ) : null}
                        </div>
                        <div className="race-history-event-line" />
                      </div>
                    );
                  } else if (t.type === "drop") {
                    out.push(
                      <div key={t.id} className="race-history-event">
                        <div className="race-history-event-line" />
                        <div className="race-history-event-text">
                          Racer dropped:{" "}
                          {scout ? (
                            <strong>#{scout.carNumber} {scout.name}</strong>
                          ) : (
                            <strong>Unknown</strong>
                          )}
                        </div>
                        <div className="race-history-event-line" />
                      </div>
                    );
                  }
                });

                out.push(
                  <div key={heat.id} className="race-item">
                    <div className="race-meta">
                      <strong>Race {i + 1}</strong>
                      <span className="muted">{new Date(heat.createdAt).toLocaleString()}</span>
                    </div>
                    {heat.placements.length === 0 ? (
                      <p className="muted">Not finished</p>
                    ) : (
                      <ol className="race-placements">
                        {heat.placements.map((placement) => (
                          <li key={`${heat.id}-${placement.place}`}>
                            <span className="place-chip">#{placement.place}</span>
                            <span
                              className={[
                                "placement-name",
                                placement.scout && heat.eliminatedScoutIds.includes(placement.scout.id) ? "eliminated-strike" : "",
                              ].filter(Boolean).join(" ")}
                            >
                              {placement.scout ? `#${placement.scout.carNumber} ${placement.scout.name}` : "Unknown"}
                              {placement.scout?.groupName ? ` (${placement.scout.groupName})` : ""}
                            </span>
                            {placement.scout ? (
                              <span className="placement-points muted">
                                {pointsAfterByHeatId.get(heat.id)?.get(placement.scout.id) ?? placement.scout.points} pts
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                );

                cursor = heat.createdAt;
              }

              const trailing = events.filter((t) => t.createdAt > cursor);
              trailing.forEach((t) => {
                const scout = t.scoutId ? results.event.scouts.find((s) => s.id === t.scoutId) ?? null : null;
                if (t.type === "late_entrant") {
                  out.push(
                    <div key={t.id} className="race-history-event">
                      <div className="race-history-event-line" />
                      <div className="race-history-event-text">
                        Late entrant added:{" "}
                        {scout ? (
                          <strong>#{scout.carNumber} {scout.name}</strong>
                        ) : (
                          <strong>Unknown</strong>
                        )}
                        {typeof t.pointsPenalty === "number" ? (
                          <span className="muted"> — {t.pointsPenalty} pt penalty</span>
                        ) : null}
                      </div>
                      <div className="race-history-event-line" />
                    </div>
                  );
                } else if (t.type === "drop") {
                  out.push(
                    <div key={t.id} className="race-history-event">
                      <div className="race-history-event-line" />
                      <div className="race-history-event-text">
                        Racer dropped:{" "}
                        {scout ? (
                          <strong>#{scout.carNumber} {scout.name}</strong>
                        ) : (
                          <strong>Unknown</strong>
                        )}
                      </div>
                      <div className="race-history-event-line" />
                    </div>
                  );
                }
              });

              return out;
            })()}
          </div>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ClaimLocalGuestEventsOnAuth />
        <PageTitle />
        <QuickStartOverlay />
        <DonateOverlay />
        <Routes>
          <Route path="/" element={<KioskBootPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/patrols" element={<RacePatrolsPage />} />
          <Route path="/kiosk/:eventId" element={<KioskPage />} />
          <Route path="/guest-kiosk/:token" element={<GuestKioskRedeemPage />} />
          <Route path="/pair/:qrToken" element={<PairingPage />} />
          <Route path="/configure/:token" element={<ConfigurePage />} />
          <Route path="/events/:eventId/scouts" element={<AddScoutsPage />} />
          <Route path="/control/:eventId" element={<RaceControlPage />} />
          <Route path="/results/:eventId" element={<ResultsPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
