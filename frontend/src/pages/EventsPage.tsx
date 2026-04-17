import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { TrashIcon } from "../components/TrashIcon";
import { api, isAuthRequiredError } from "../shared/api";
import { guestClaimStatusEventName } from "../shared/events";
import {
  getLocalGuestEventIds,
  getStoredGuestAccessUrls,
  kioskSessionStorageKey,
  removeLocalGuestEventId,
  setLocalGuestEventIds,
  setStoredGuestAccessUrls,
} from "../shared/storage";
import type { EventListResponse, EventState } from "../shared/types";

function formatDateTimeMinutes(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EventsPage() {
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
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadGuestEvents();
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
      void loadEvents();
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
                  <div className="event-info">
                    <div className="event-title-row">
                      <h3 style={{ margin: 0 }}>{event.name}</h3>
                      <button
                        className="danger-btn corner-delete-btn icon-btn"
                        onClick={() => void deleteGuestEvent(event.id)}
                        aria-label="Delete event"
                        title="Delete event"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                    <div className="event-meta">
                      <span className={`status-badge ${event.isComplete ? "finished" : event.setupComplete ? "in-progress" : "setup"}`}>
                        {event.isComplete ? "Finished" : event.setupComplete ? "In progress" : "Setup"}
                      </span>
                      <span><strong>{event.scouts.length}</strong> Racers</span>
                      <span><strong>{event.lanes}</strong> Lanes</span>
                      <span className="muted">Created: {formatDateTimeMinutes(event.createdAt)}</span>
                      <span className="muted">Last used: {formatDateTimeMinutes(event.lastUsedAt)}</span>
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
                <button className="secondary-btn" onClick={() => void loadEvents()}>Refresh</button>
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
                  <div className="event-info">
                    <div className="event-title-row">
                      <h3 style={{ margin: 0 }}>{event.name}</h3>
                      <button
                        className="danger-btn corner-delete-btn icon-btn"
                        onClick={() => void deleteEvent(event.id)}
                        aria-label="Delete event"
                        title="Delete event"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                    <div className="event-meta">
                      <span className={`status-badge ${event.isComplete ? "finished" : event.setupComplete ? "in-progress" : "setup"}`}>
                        {event.isComplete ? "Finished" : event.setupComplete ? "In progress" : "Setup"}
                      </span>
                      <span><strong>{event.scouts.length}</strong> Racers</span>
                      <span><strong>{event.lanes}</strong> Lanes</span>
                      <span className="muted">Created: {formatDateTimeMinutes(event.createdAt)}</span>
                      <span className="muted">Last used: {formatDateTimeMinutes(event.lastUsedAt)}</span>
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
                      <button className="secondary-btn" onClick={() => void generateGuestAccessUrl(event.id)}>Generate Guest Access URL</button>
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
