import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { useEvent } from "../hooks/useEvent";
import { api, isAuthRequiredError } from "../shared/api";
import { removeLocalGuestEventId } from "../shared/storage";
import type { EventState, Scout } from "../shared/types";

export function RaceControlPage() {
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
    return currentHeat.laneAssignments
      .map((scoutId, laneIndex) => ({ scoutId, laneIndex }))
      .filter((entry) => !picked.has(entry.scoutId));
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
      {event.isGuest && !user ? (
        <div className="banner info desktop-only">
          This is a guest event. <Link to="/login">Login</Link> or <Link to="/signup">Signup</Link> to save it to your account.
        </div>
      ) : null}
      {event.isGuest && user ? (
        <div className="banner info desktop-only">
          This is a guest event. <button onClick={() => void claimEvent()} className="text-btn">Save to my account</button>
        </div>
      ) : null}
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
              {remainingFinishers.map(({ scoutId, laneIndex }) => (
                <button key={scoutId} onClick={() => selectFinisher(scoutId)}>
                  <span className="scout-pick-card">
                    <span className="scout-pick-lane">Lane {laneIndex + 1}</span>
                    <span className="scout-pick">
                      <span className="scout-pick-number">#{scoutById.get(scoutId)?.carNumber}</span>
                      <span className="scout-pick-name">{scoutById.get(scoutId)?.name}</span>
                      {scoutById.get(scoutId)?.groupName ? (
                        <span className="scout-pick-group">({scoutById.get(scoutId)?.groupName})</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button type="button" className="secondary-btn" onClick={undoFinisher} disabled={finishOrder.length === 0}>Undo</button>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => void submitHeatResult()} disabled={finishOrder.length !== currentHeat.laneAssignments.length}>Submit results</button>
            </div>
          </>
        ) : event.heats.length === 0 ? (
          <button onClick={() => void generateHeat()} disabled={event.isComplete}>Generate starting heat</button>
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
