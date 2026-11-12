import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { PatrolImportDialog, type ImportSource } from "../components/PatrolImportDialog";
import { TrashIcon } from "../components/TrashIcon";
import { api } from "../shared/api";
import { CSV_TEMPLATE, racersFromCsv } from "../shared/racerImport";
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
  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  const readCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setNotice("");
    try {
      const { racers, skipped } = racersFromCsv(await file.text());
      setImporting({ kind: "csv", fileName: file.name, racers, skipped });
    } catch {
      setError("That file couldn't be read. Save it from your spreadsheet as CSV and try again.");
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "race-patrol-template.csv";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        <div className="card-head">
          <div>
            <h1>Race Patrols</h1>
            <p className="muted">Lists of racers you can add to an event in one go: a patrol, a six, or the whole unit.</p>
          </div>
          <div className="inline-actions">
            <button onClick={openNew}>New patrol</button>
            <button className="secondary-btn" onClick={() => navigate("/events")}>Back to events</button>
          </div>
        </div>
        <div className="import-actions" aria-label="Import racers">
          <button type="button" className="import-option" onClick={() => { setNotice(""); setImporting({ kind: "terrain" }); }}>
            <strong>Import from Terrain</strong>
            <span className="muted">Your unit's youth, grouped by patrol</span>
          </button>
          <button type="button" className="import-option" onClick={() => fileRef.current?.click()}>
            <strong>Import a spreadsheet</strong>
            <span className="muted">A CSV file with names, and groups and weights if you have them</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => void readCsv(e)} aria-label="CSV file" />
        </div>
        <p className="fine-print">
          Spreadsheet columns: Name (or First name and Last name), Group (or Patrol, Six, Den) and Weight.{" "}
          <button type="button" className="text-btn" onClick={downloadTemplate}>Download a template</button>
        </p>
        {notice ? <p className="banner success-banner" role="status">{notice}</p> : null}
        {loading ? <p className="muted">Loading patrols…</p> : null}
        {error && !editorOpen ? <p className="error">{error}</p> : null}
      </section>

      <section className="card">
        <h2>Your Patrols</h2>
        {patrols.length === 0 && !loading ? <p className="muted">No patrols yet. Make one, or import your unit above.</p> : null}
        <div className="patrol-list">
          {patrols.map((p) => (
            <div key={p.id} className="patrol-card">
              <div className="patrol-row">
                <div className="patrol-row-left">
                  <h3>{p.name}</h3>
                  <div className="muted">{p.racers.length} racer{p.racers.length === 1 ? "" : "s"}</div>
                </div>
                <div className="inline-actions patrol-actions">
                  <button className="secondary-btn" onClick={() => openEdit(p)}>Edit</button>
                  <button className="danger-btn icon-btn" onClick={() => void deletePatrol(p.id)} aria-label={`Delete ${p.name}`} title="Delete">
                    <TrashIcon />
                  </button>
                </div>
              </div>
              <p className="patrol-names">{p.racers.map((r) => r.name).join(", ")}</p>
            </div>
          ))}
        </div>
      </section>

      {importing ? (
        <PatrolImportDialog
          source={importing}
          existing={patrols}
          onClose={() => setImporting(null)}
          onImported={(message) => {
            setImporting(null);
            setNotice(message);
            void loadPatrols();
          }}
        />
      ) : null}

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
              <div className="racer-rows">
                <h3>Racers ({racers.filter((r) => r.name.trim()).length})</h3>
                {racers.map((r) => (
                  <div key={r.id} className="racer-row">
                    <label>
                      Name
                      <input
                        value={r.name}
                        onChange={(e) => setRacers((prev) => prev.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                        required
                      />
                    </label>
                    <label>
                      Group (optional)
                      <input
                        value={r.groupName}
                        onChange={(e) => setRacers((prev) => prev.map((x) => (x.id === r.id ? { ...x, groupName: e.target.value } : x)))}
                      />
                    </label>
                    <label>
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
                      className="danger-btn entry-remove"
                      onClick={() => setRacers((prev) => prev.filter((x) => x.id !== r.id))}
                      disabled={racers.length <= 1}
                      aria-label={r.name ? `Remove ${r.name}` : "Remove racer"}
                    >
                      ×
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

