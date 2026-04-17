import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { TrashIcon } from "../components/TrashIcon";
import { api } from "../shared/api";
import type { RacePatrol, RacePatrolListResponse } from "../shared/types";

export function RacePatrolsPage() {
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
    void loadPatrols();
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
                <div className="patrol-row">
                  <div className="patrol-row-left">
                    <h3 style={{ margin: 0 }}>{p.name}</h3>
                    <div className="muted">{p.racers.length} racer{p.racers.length === 1 ? "" : "s"}</div>
                  </div>
                  <div className="inline-actions patrol-actions">
                    <button className="secondary-btn" onClick={() => openEdit(p)}>Edit</button>
                    <button className="danger-btn icon-btn" onClick={() => void deletePatrol(p.id)} aria-label="Delete patrol" title="Delete">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
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

