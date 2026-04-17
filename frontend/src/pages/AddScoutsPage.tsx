import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { useEvent } from "../hooks/useEvent";
import { api, isAuthRequiredError } from "../shared/api";
import type { EventState, RacePatrol, RacePatrolListResponse } from "../shared/types";

export function AddScoutsPage() {
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

  const removeRacer = async (scoutId: string) => {
    if (!eventId) return;
    const scout = event?.scouts.find((s) => s.id === scoutId);
    if (!scout) return;
    if (!window.confirm(`Remove #${scout.carNumber} ${scout.name} from this event?`)) return;
    setError("");
    try {
      await api(`/events/${eventId}/scouts/${scoutId}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
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

  const patrolImportStatusById = useMemo(() => {
    const out = new Map<string, { total: number; missing: number }>();
    if (!event) return out;
    const importedRacerIds = new Set(
      event.scouts
        .map((s) => s.sourcePatrolRacerId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    patrols.forEach((p) => {
      const total = p.racers.length;
      const missing = p.racers.reduce((count, r) => count + (importedRacerIds.has(r.id) ? 0 : 1), 0);
      out.set(p.id, { total, missing });
    });
    return out;
  }, [event, patrols]);

  const selectedPatrolMissingCount = useMemo(() => {
    return selectedPatrolIds.reduce((sum, id) => sum + (patrolImportStatusById.get(id)?.missing ?? 0), 0);
  }, [selectedPatrolIds, patrolImportStatusById]);

  const togglePatrol = (patrolId: string) => {
    const missing = patrolImportStatusById.get(patrolId)?.missing ?? 0;
    if (missing <= 0) return;
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
                (() => {
                  const status = patrolImportStatusById.get(p.id);
                  const missing = status?.missing ?? p.racers.length;
                  const total = status?.total ?? p.racers.length;
                  const fullyAdded = total > 0 && missing === 0;
                  const partiallyAdded = total > 0 && missing > 0 && missing < total;
                  const statusText = fullyAdded ? "Added" : partiallyAdded ? `Missing ${missing}` : "";
                  return (
                    <label key={p.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontWeight: 700 }}>
                      <input
                        type="checkbox"
                        checked={selectedPatrolIds.includes(p.id)}
                        onChange={() => togglePatrol(p.id)}
                        disabled={missing === 0}
                        style={{ width: "1.1rem", height: "1.1rem" }}
                      />
                      <span style={{ flex: 1 }}>
                        {p.name} <span className="muted">({p.racers.length} racer{p.racers.length === 1 ? "" : "s"})</span>
                      </span>
                      {statusText ? <span className="muted">{statusText}</span> : null}
                    </label>
                  );
                })()
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
              disabled={selectedPatrolIds.length === 0 || importingPatrols || selectedPatrolMissingCount === 0}
            >
              {importingPatrols ? "Adding…" : `Add ${selectedPatrolMissingCount} racer${selectedPatrolMissingCount === 1 ? "" : "s"}`}
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
              <button type="button" className="danger-btn entry-remove" onClick={() => void removeRacer(s.id)} aria-label="Remove racer">
                ×
              </button>
            </li>
          ))}
        </ul>
        {event.scouts.length === 0 ? <p className="muted">No racers added yet.</p> : null}
      </section>

      <div className="wizard-actions">
        <button className="secondary-btn" onClick={() => navigate(-1)}>Back to settings</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => void finishSetup()} disabled={event.scouts.length < 2}>
          {event.scouts.length < 2 ? "Add at least 2 racers" : "Start Race Control"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

