import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { api, isAuthRequiredError } from "../shared/api";
import type { EventResults } from "../shared/types";

export function ResultsPage() {
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

