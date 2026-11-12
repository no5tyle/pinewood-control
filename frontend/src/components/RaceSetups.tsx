/*
  Saved race setups on the Events page: the lanes, elimination points, kiosk theme and weight unit an
  event uses, kept under a name. Setting up an event from one leaves only the racers to add.
*/
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../shared/api";
import { describeSetup, THEME_NAMES } from "../shared/raceSetups";
import type { RaceSetup, ThemeName } from "../shared/types";
import { TrashIcon } from "./TrashIcon";

type Draft = Omit<RaceSetup, "id" | "updatedAt"> & { id?: string };

const blank: Draft = { name: "", lanes: 4, pointLimit: 3, theme: "system", weightUnit: "g" };

export function RaceSetupsCard() {
  const [setups, setSetups] = useState<RaceSetup[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setSetups((await api<{ setups: RaceSetup[] }>("/race-setups")).setups);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (setup: RaceSetup) => {
    if (!window.confirm(`Delete the race setup "${setup.name}"? Events already set up with it don't change.`)) return;
    try {
      await api(`/race-setups/${setup.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Race setups</h2>
          <p className="muted">Lanes, points and theme saved under a name. Start an event from one and only add the racers.</p>
        </div>
        <button className="secondary-btn" onClick={() => setEditing({ ...blank })}>New setup</button>
      </div>
      {setups.length === 0 ? <p className="muted">No setups yet. Make one here, or save one at the end of setting up an event.</p> : null}
      <div className="patrol-list">
        {setups.map((s) => (
          <div key={s.id} className="patrol-card">
            <div className="patrol-row">
              <div className="patrol-row-left">
                <h3>{s.name}</h3>
                <div className="muted">{describeSetup(s)}</div>
              </div>
              <div className="inline-actions patrol-actions">
                <button className="secondary-btn" onClick={() => setEditing({ ...s })}>Edit</button>
                <button className="danger-btn icon-btn" onClick={() => void remove(s)} aria-label={`Delete ${s.name}`} title="Delete">
                  <TrashIcon />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {editing ? (
        <RaceSetupEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function RaceSetupEditor({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    const body = JSON.stringify({ name: form.name, lanes: form.lanes, pointLimit: form.pointLimit, theme: form.theme, weightUnit: form.weightUnit });
    try {
      if (form.id) await api(`/race-setups/${form.id}`, { method: "PATCH", body });
      else await api("/race-setups", { method: "POST", body });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={form.id ? "Edit race setup" : "New race setup"}>
      <section className="card modal-card" ref={cardRef} tabIndex={-1}>
        <button className="close-overlay" onClick={onClose} aria-label="Close">×</button>
        <h2>{form.id ? "Edit race setup" : "New race setup"}</h2>
        <form className="stack" onSubmit={(e) => void save(e)}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Cub Derby, 4-lane track" maxLength={80} required />
          </label>
          <div className="setup-fields">
            <label>
              Lanes
              <input type="number" min={2} max={12} value={form.lanes} onChange={(e) => setForm({ ...form, lanes: Number(e.target.value) })} required />
            </label>
            <label>
              Out at (points)
              <input type="number" min={1} max={200} value={form.pointLimit} onChange={(e) => setForm({ ...form, pointLimit: Number(e.target.value) })} required />
            </label>
          </div>
          <div className="setup-fields">
            <label>
              Kiosk theme
              <select value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value as ThemeName })}>
                {Object.entries(THEME_NAMES).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Weights in
              <select value={form.weightUnit} onChange={(e) => setForm({ ...form, weightUnit: e.target.value as "g" | "oz" })}>
                <option value="g">grams</option>
                <option value="oz">ounces</option>
              </select>
            </label>
          </div>
          <div className="wizard-actions">
            <button type="button" className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save setup"}</button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </form>
      </section>
    </div>
  );
}
