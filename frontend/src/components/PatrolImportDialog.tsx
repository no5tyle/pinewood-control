/*
  Brings racers into Race Patrols from a CSV file or from Terrain, then lets the leader choose one patrol
  for everyone or one per group (patrol, six, den) before saving. A patrol with the same name as an
  existing one is updated rather than duplicated, so importing again next term refreshes the lists.

  Terrain's login lives in this dialog only: the password goes straight to Terrain from the browser and
  the token is dropped when the dialog closes.
*/
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../shared/api";
import { groupCount, planPatrols, type ImportedRacer } from "../shared/racerImport";
import { BRANCHES, racersFromMembers, TerrainSession, unitLabel, type TerrainMember, type TerrainUnit } from "../shared/terrain";
import type { RacePatrol } from "../shared/types";

const BRANCH_KEY = "pinewood_terrain_branch";

export type ImportSource =
  | { kind: "csv"; fileName: string; racers: ImportedRacer[]; skipped: string[] }
  | { kind: "terrain" };

type Step =
  | { at: "signin" }
  | { at: "units"; units: TerrainUnit[] }
  | { at: "review"; racers: ImportedRacer[]; members?: TerrainMember[]; defaultName: string; skipped: string[] };

export function PatrolImportDialog({
  source,
  existing,
  onClose,
  onImported,
}: {
  source: ImportSource;
  existing: RacePatrol[];
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>(() =>
    source.kind === "csv"
      ? { at: "review", racers: source.racers, skipped: source.skipped, defaultName: source.fileName.replace(/\.[^.]+$/, "") }
      : { at: "signin" },
  );
  const session = useRef<TerrainSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      session.current = null;
    };
  }, [onClose]);

  const loadUnit = async (unit: TerrainUnit) => {
    if (!session.current) return;
    setBusy(true);
    setError("");
    try {
      const members = await session.current.members(unit.id);
      const racers = racersFromMembers(members);
      if (racers.length === 0) throw new Error("Terrain lists no youth members in that unit.");
      setStep({ at: "review", racers, members, defaultName: unitLabel(unit), skipped: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const branch = String(form.get("branch") ?? "");
    const memberNumber = String(form.get("member") ?? "");
    const password = String(form.get("password") ?? "");
    if (!branch) return setError("Choose your branch.");
    setBusy(true);
    setError("");
    try {
      session.current = await TerrainSession.login(branch, memberNumber, password);
      window.localStorage.setItem(BRANCH_KEY, branch);
      const units = await session.current.units();
      if (units.length === 0) throw new Error("Terrain doesn't list you as a leader of any unit, so there are no members to import.");
      setBusy(false);
      if (units.length === 1) await loadUnit(units[0]);
      else setStep({ at: "units", units });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const title = source.kind === "csv" ? "Import from a spreadsheet" : "Import from Terrain";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <section className="card modal-card import-card" ref={cardRef} tabIndex={-1}>
        <button className="close-overlay" onClick={onClose} aria-label="Close">×</button>
        <h2>{title}</h2>

        {step.at === "signin" ? (
          <form className="stack" onSubmit={(e) => void signIn(e)}>
            <p className="muted">
              Log in with your Scouts Australia member number and Terrain password to bring in your unit's youth,
              grouped by their patrol.
            </p>
            <label>
              Branch
              <select name="branch" defaultValue={window.localStorage.getItem(BRANCH_KEY) ?? ""} required>
                <option value="">Choose branch</option>
                {BRANCHES.map((b) => (
                  <option key={b} value={b.toLowerCase()}>{b}</option>
                ))}
              </select>
            </label>
            <label>
              Member number
              <input name="member" inputMode="numeric" autoComplete="username" required />
            </label>
            <label>
              Terrain password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <p className="fine-print">
              Your password goes straight to Terrain from this device. Pinewood Control never sees or keeps it, and
              only reads names and patrols.
            </p>
            <div className="wizard-actions">
              <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
              <button type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in to Terrain"}</button>
            </div>
          </form>
        ) : null}

        {step.at === "units" ? (
          <div className="stack">
            <p className="muted">Which unit's members?</p>
            <div className="choice-list">
              {step.units.map((unit) => (
                <button key={unit.id} type="button" className="choice" onClick={() => void loadUnit(unit)} disabled={busy}>
                  <strong>{unitLabel(unit)}</strong>
                  <span className="muted">{unit.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step.at === "review" ? (
          <Review
            key={step.defaultName}
            racers={step.racers}
            members={step.members}
            defaultName={step.defaultName}
            skipped={step.skipped}
            existing={existing}
            onCancel={onClose}
            onImported={onImported}
          />
        ) : null}

        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}

function Review({
  racers: initialRacers,
  members,
  defaultName,
  skipped,
  existing,
  onCancel,
  onImported,
}: {
  racers: ImportedRacer[];
  members?: TerrainMember[];
  defaultName: string;
  skipped: string[];
  existing: RacePatrol[];
  onCancel: () => void;
  onImported: (message: string) => void;
}) {
  const [includeLeaders, setIncludeLeaders] = useState(false);
  const racers = useMemo(
    () => (members ? racersFromMembers(members, { includeLeaders }) : initialRacers),
    [members, includeLeaders, initialRacers],
  );
  const groups = groupCount(racers);
  const [split, setSplit] = useState(groups > 1);
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const hasLeaders = (members ?? []).some((m) => m.unit?.duty === "adult_leader");

  const plan = useMemo(
    () => planPatrols(racers, { split, name, existing: existing.map((p) => ({ id: p.id, name: p.name })) }),
    [racers, split, name, existing],
  );
  const updates = plan.filter((p) => p.existingId).length;

  const save = async () => {
    if (plan.length === 0) return;
    const tooBig = plan.find((p) => p.racers.length > 300);
    if (tooBig) return setError(`${tooBig.name} has ${tooBig.racers.length} racers; a patrol can hold 300.`);
    setSaving(true);
    setError("");
    try {
      for (const patrol of plan) {
        const body = JSON.stringify({ name: patrol.name, racers: patrol.racers });
        if (patrol.existingId) await api(`/patrols/${patrol.existingId}`, { method: "PATCH", body });
        else await api("/patrols", { method: "POST", body });
      }
      const made = plan.length - updates;
      const parts = [made ? `${made} new patrol${made === 1 ? "" : "s"}` : "", updates ? `${updates} updated` : ""].filter(Boolean);
      onImported(`Imported ${racers.length} racer${racers.length === 1 ? "" : "s"}: ${parts.join(", ")}.`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  if (racers.length === 0) {
    return (
      <div className="stack">
        <p>No racers were found in that file. It needs a column of names, ideally with a Name heading.</p>
        {skipped.length ? <SkippedRows rows={skipped} /> : null}
        <div className="wizard-actions">
          <button type="button" onClick={onCancel}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted">
        {racers.length} racer{racers.length === 1 ? "" : "s"}
        {groups > 0 ? ` in ${groups} group${groups === 1 ? "" : "s"}` : ""}. Choose how to save them.
      </p>

      <div className="segmented" role="radiogroup" aria-label="How to save them">
        <button type="button" role="radio" aria-checked={split} className={split ? "on" : ""} onClick={() => setSplit(true)} disabled={groups === 0}>
          A patrol per group
        </button>
        <button type="button" role="radio" aria-checked={!split} className={!split ? "on" : ""} onClick={() => setSplit(false)}>
          One patrol for everyone
        </button>
      </div>

      {!split || plan.some((p) => p.racers.some((r) => !r.groupName)) ? (
        <label>
          {split ? "Patrol name for racers without a group" : "Patrol name"}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
      ) : null}

      {hasLeaders ? (
        <label className="check">
          <input type="checkbox" checked={includeLeaders} onChange={(e) => setIncludeLeaders(e.target.checked)} />
          Include the unit's adult leaders
        </label>
      ) : null}

      <ul className="import-plan">
        {plan.map((p) => (
          <li key={p.name}>
            <div className="import-plan-head">
              <strong>{p.name}</strong>
              <span className={`status-badge ${p.existingId ? "in-progress" : "setup"}`}>{p.existingId ? "Updates existing" : "New"}</span>
              <span className="muted">{p.racers.length} racer{p.racers.length === 1 ? "" : "s"}</span>
            </div>
            <p className="import-plan-names">{p.racers.map((r) => r.name).join(", ")}</p>
          </li>
        ))}
      </ul>

      {skipped.length ? <SkippedRows rows={skipped} /> : null}

      <div className="wizard-actions">
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : `Save ${plan.length} patrol${plan.length === 1 ? "" : "s"}`}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

function SkippedRows({ rows }: { rows: string[] }) {
  return (
    <details className="skipped">
      <summary>{rows.length} row{rows.length === 1 ? "" : "s"} needed attention</summary>
      <ul>
        {rows.slice(0, 50).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </details>
  );
}
