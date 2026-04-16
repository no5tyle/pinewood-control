import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
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
  points: number;
  eliminated: boolean;
};

type Heat = {
  id: string;
  laneAssignments: string[];
  winnerScoutId?: string;
};

type EventState = {
  id: string;
  name: string;
  pointLimit: number;
  lanes: number;
  setupComplete: boolean;
  theme: string;
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
  heatResults: Array<{
    id: string;
    createdAt: number;
    placements: Array<{ place: number; scout: Scout | null }>;
    winnerScoutId: string | null;
    loserScoutIds: string[];
  }>;
};

type EventListResponse = {
  events: EventState[];
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
type ThemeName = "system" | "scouts-au-cubs" | "scouts-america";

function safeParseStorageJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
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
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dismissed = window.localStorage.getItem(quickStartDismissedStorageKey);
    if (dismissed === "1") return;
    setOpen(true);
  }, []);

  if (!open) return null;
  if (!(location.pathname === "/" || location.pathname === "/events")) return null;

  const close = () => {
    window.localStorage.setItem(quickStartDismissedStorageKey, "1");
    setOpen(false);
  };

  return (
    <div className="quickstart-overlay" role="dialog" aria-modal="true" aria-label="Quick start guide">
      <section className="card quickstart-card">
        <button className="close-overlay" onClick={close} aria-label="Close">×</button>
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
          <button className="secondary-btn" onClick={() => { close(); navigate("/help"); }}>Help</button>
          <div style={{ flex: 1 }} />
          <button onClick={close}>Get Started</button>
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
          <li>It prioritizes lane fairness so racers get a balanced distribution of lanes over time.</li>
          <li>It groups racers with similar points where possible (to keep heats competitive).</li>
          <li>It tries to minimize repeat matchups between the same racers.</li>
          <li>If it cannot generate a valid heat with the remaining racers, it will refuse rather than create a single-car heat.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Rankings & Elimination</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Each heat awards points by finish position: 1st = 0 points, 2nd = 1 point, 3rd = 2 points, etc.</li>
          <li>Total points accumulate across heats.</li>
          <li>A racer is eliminated when points are greater than or equal to the event point limit.</li>
          <li>Standings sort by: not eliminated first, then lowest points, then name.</li>
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
      const res = await api<{ token: string; user: any }>("/auth/login", {
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
      const res = await api<{ token: string; user: any }>("/auth/register", {
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

function AppHeader({ onRelink }: { onRelink?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <header className="app-header">
      <Link to="/" className="app-brand">Pinewood Control</Link>
      <div className="app-header-actions">
        {onRelink ? (
          <button className="profile-btn relink-btn" onClick={onRelink} aria-label="Relink device">
            <span className="profile-icon" aria-hidden="true">🔗</span>
            <span>Relink</span>
          </button>
        ) : null}
        <Link to="/events" className="profile-btn" aria-label="View events">
          <span className="profile-icon" aria-hidden="true">🏆</span>
          <span>Events</span>
        </Link>
        <Link to="/help" className="profile-btn" aria-label="Help">
          <span className="profile-icon" aria-hidden="true">?</span>
          <span>Help</span>
        </Link>
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
      })
      .catch((err: Error) => setError(err.message));
  }, [token, navigate]);

  const saveAndNext = async (e: FormEvent) => {
    e.preventDefault();
    if (!session?.eventId) return;
    
    if (step < 3) {
      setStep(step + 1);
      return;
    }

    try {
      const lanesNum = Number(lanes);
      if (!Number.isFinite(lanesNum) || lanes.trim().length === 0) {
        setError("Please enter the number of lanes.");
        return;
      }
      if (lanesNum < 2 || lanesNum > 6) {
        setError("Lanes must be between 2 and 6.");
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
        body: JSON.stringify({ pointLimit: pointLimitNum, lanes: lanesNum, theme }),
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
              <input type="number" min={2} max={6} value={lanes} onChange={(e) => setLanes(e.target.value)} autoFocus />
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
  const { event, error: eventError } = useEvent(eventId);
  const [scoutName, setScoutName] = useState("");
  const [carNumber, setCarNumber] = useState("");
  const [error, setError] = useState("");

  const addScout = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    try {
      await api(`/events/${eventId}/scouts`, {
        method: "POST",
        body: JSON.stringify({ name: scoutName, carNumber }),
      });
      setScoutName("");
      setCarNumber("");
    } catch (err) {
      setError((err as Error).message);
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
  if (!event) return <main className="home-page"><p>Loading contestants...</p></main>;

  return (
    <main className="home-page">
      <h1>Add Contestants</h1>
      <form className="card" onSubmit={addScout}>
        <h2>Add Racer</h2>
        <label>Racer<input value={scoutName} onChange={(e) => setScoutName(e.target.value)} required /></label>
        <label>Car number<input value={carNumber} onChange={(e) => setCarNumber(e.target.value)} required /></label>
        <button type="submit">Add contestant</button>
      </form>

      <section className="card">
        <h2>Current Entry List ({event.scouts.length})</h2>
        <ul className="standings">
          {event.scouts.map((s) => (
            <li key={s.id}>
              <span>{s.name}</span>
              <span>#{s.carNumber}</span>
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

  useEffect(() => {
    setFinishOrder([]);
  }, [currentHeat?.id]);

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
                      {ordinal(index + 1)}: {scoutById.get(scoutId)?.name}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="stack">
              {remainingFinishers.map((scoutId) => (
                <button key={scoutId} onClick={() => selectFinisher(scoutId)}>
                  {scoutById.get(scoutId)?.name}
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
              <span>{s.name}</span>
              <span>{s.eliminated ? "Out" : `${s.points} point${s.points === 1 ? "" : "s"}`}</span>
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
      {submitError ? <p className="error">{submitError}</p> : null}
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
  const [namingError, setNamingError] = useState("");
  const [previousWinner, setPreviousWinner] = useState<Scout | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);
  const [lastActiveHeatId, setLastActiveHeatId] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<"idle" | "copying" | "copied">("idle");
  const shareTimerRef = useRef<number | null>(null);

  const isNewEvent = eventId === "new" || (event?.name === "New Pinewood Derby Event" && !event?.setupComplete);
  const kioskTheme = (event?.theme as ThemeName | undefined) ?? "system";

  useEffect(() => {
    return () => {
      if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
    };
  }, []);

  const copyKioskLink = async () => {
    if (!event?.id) return;
    setShareStatus("copying");

    const base = getQrPrefix();
    let url = `${base}/kiosk/${event.id}`;
    if (user && !event.isGuest) {
      try {
        const res = await api<{ token: string; expiresAt: number }>(`/events/${event.id}/guest-kiosk-link`, { method: "POST" });
        url = `${base}/guest-kiosk/${res.token}`;
      } catch {}
    }

    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link:", url);
    }

    setShareStatus("copied");
    if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
    shareTimerRef.current = window.setTimeout(() => setShareStatus("idle"), 1500);
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

  useEffect(() => {
    if (event?.name && event.name !== "New Pinewood Derby Event") {
      setNewName(event.name);
    }
  }, [event?.name]);

  const handleNameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !sessionToken) return;
    try {
      const res = await api<EventState>(`/kiosk/sessions/${sessionToken}/create-event`, {
        method: "POST",
        body: JSON.stringify({ name: newName, lanes: 4, pointLimit: 10 }),
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
    if (event.isComplete) {
      if (showWinnerOverlay) setShowWinnerOverlay(false);
      if (previousWinner) setPreviousWinner(null);
      return;
    }
    
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
  }, [event?.heats, currentHeat?.id, lastActiveHeatId, scoutMap, showWinnerOverlay]);

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
                  value={newName} 
                  onChange={(e) => setNewName(e.target.value)} 
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
                <div className="configuring-icon">⚙️</div>
                <h2>Configuring Event</h2>
                <p>Please wait while the operator finishes setup.</p>
              </div>
            ) : event.isComplete && event.championScoutId ? (
              <div className="kiosk-final">
                <div className="kiosk-final-hero">
                  <div className="kiosk-final-title">Final Standings</div>
                  <div className="kiosk-final-winner">
                    Champion: <span className="kiosk-final-winner-name">{scoutMap.get(event.championScoutId)?.name}</span>
                  </div>
                </div>
                <div className="kiosk-final-standings">
                  {event.standings.map((scout, index) => (
                    <div
                      key={scout.id}
                      className={`kiosk-final-row ${index < 3 ? `rank-${index + 1}` : ""}`}
                    >
                      <span className="kiosk-final-rank">{index + 1}</span>
                      <span className="kiosk-final-name">{scout.name}</span>
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
                      <div className="winner-name-large">{previousWinner.name}</div>
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
                            <span className="lane-scout">{scoutMap.get(scoutId)?.name}</span>
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
                        <span className="standing-name">{scout.name}</span>
                        <span className="standing-status">
                        {scout.eliminated ? "Out" : `${scout.points} point${scout.points === 1 ? "" : "s"}`}
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
              <h2>Link Operator</h2>
              {qrSrc ? <img src={qrSrc} alt="Scan to control event" /> : <p>Generating QR...</p>}
              {pairingCode ? (
                <div className="pairing-code-display">
                  <code>{pairingCode}</code>
                </div>
              ) : null}
              {qrUrl ? <div className="overlay-note" style={{ wordBreak: "break-all" }}>{qrUrl}</div> : null}
              <p className="overlay-note">Scan QR and enter code to link device</p>
              <div className="overlay-actions">
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
          {shareStatus === "copied" ? "✓ Link copied" : shareStatus === "copying" ? "…" : "🔗 Link"}
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
          <div className="champion-badge">🏆</div>
          <h1>{results.event.name}</h1>
          <div className="champion-name">
            Champion: <strong>{results.champion?.name ?? "TBD"}</strong>
          </div>
          <div className="event-stats">
            <span><strong>{results.heatResults.length}</strong> Heats</span>
            <span><strong>{results.event.scouts.length}</strong> Racers</span>
          </div>
        </section>

        <section className="card">
          <h2>Final Standings</h2>
          <div className="standings-grid">
            {results.event.standings.map((scout, index) => (
              <div key={scout.id} className={`standings-item ${index < 3 ? `rank-${index + 1}` : ""}`}>
                <span className="rank">{index + 1}</span>
                <span className="scout-name">{scout.name}</span>
                <span className="car-number">#{scout.carNumber}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Race History</h2>
          {results.heatResults.length === 0 ? <p className="muted">No races recorded yet.</p> : null}
          <div className="race-history">
            {results.heatResults.map((heat, index) => (
              <div key={heat.id} className="race-item">
                <div className="race-meta">
                  <strong>Race {index + 1}</strong>
                  <span className="muted">{new Date(heat.createdAt).toLocaleString()}</span>
                </div>
                {heat.placements.length === 0 ? (
                  <p className="muted">Not finished</p>
                ) : (
                  <ol className="race-placements">
                    {heat.placements.map((placement) => (
                      <li key={`${heat.id}-${placement.place}`}>
                        <span className="place-chip">#{placement.place}</span>
                        <span>{placement.scout?.name ?? "Unknown"}</span>
                        {placement.scout?.carNumber ? <span className="muted">#{placement.scout.carNumber}</span> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
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
        <Routes>
          <Route path="/" element={<KioskBootPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/events" element={<EventsPage />} />
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
