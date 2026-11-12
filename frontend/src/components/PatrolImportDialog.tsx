/*
  Brings racers into Race Patrols from a CSV file or from Terrain, then lets the leader choose one patrol
  for everyone or one per group (patrol, six, den) before saving; or resyncs the patrols that came from
  Terrain with who's in those Terrain patrols now. A patrol with the same name as an existing one is
  updated rather than duplicated. A CSV upload can also replace every existing patrol.

  Everything is saved in one request (/api/patrols/import), so an import is never left half done.
  Terrain's login lives in this dialog only: the password goes straight to Terrain from the browser and
  the token is dropped when the dialog closes.
*/
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../shared/api";
import { groupCount, planPatrols, type ImportedRacer } from "../shared/racerImport";
import {
  BRANCHES,
  planResync,
  racersFromMembers,
  TerrainSession,
  unitLabel,
  type ResyncPlan,
  type TerrainMember,
  type TerrainUnit,
} from "../shared/terrain";
import type { RacePatrol, TerrainLink } from "../shared/types";
import { confirmAction } from "../shared/confirm";

const BRANCH_KEY = "pinewood_terrain_branch";

export type ImportSource =
  | { kind: "csv"; fileName: string; racers: ImportedRacer[]; skipped: string[] }
  | { kind: "terrain" }
  | { kind: "resync" };

type Step =
  | { at: "signin" }
  | { at: "units"; units: TerrainUnit[] }
  | { at: "review"; racers: ImportedRacer[]; members?: TerrainMember[]; unit?: TerrainUnit; defaultName: string; skipped: string[] }
  | { at: "resync"; plans: { unitName: string; plan: ResyncPlan }[]; missing: string[] };

interface SavedPatrol {
  name: string;
  racers: ImportedRacer[];
  existingId?: string;
  source?: "terrain" | "csv";
  terrain?: TerrainLink;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Saves a set of patrols in one go, and says what happened */
async function savePatrols(patrols: SavedPatrol[], replaceAll = false): Promise<string> {
  const res = await api<{ created: number; updated: number; deleted: number }>("/patrols/import", {
    method: "POST",
    body: JSON.stringify({ replaceAll, patrols }),
  });
  const parts = [
    res.deleted ? `${plural(res.deleted, "old patrol")} removed` : "",
    res.created ? `${plural(res.created, "new patrol")}` : "",
    res.updated ? `${res.updated} updated` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing to change.";
}

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
      setStep({ at: "review", racers, members, unit, defaultName: unitLabel(unit), skipped: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** For a resync: each unit the Terrain patrols came from, fetched again */
  const loadResync = async (units: TerrainUnit[]) => {
    if (!session.current) return;
    const linked = existing.filter((p) => p.terrain);
    const unitIds = [...new Set(linked.map((p) => p.terrain!.unitId))];
    const plans: { unitName: string; plan: ResyncPlan }[] = [];
    const missing: string[] = [];
    for (const unitId of unitIds) {
      const unitName = linked.find((p) => p.terrain!.unitId === unitId)!.terrain!.unitName;
      if (!units.some((u) => u.id === unitId)) {
        missing.push(unitName);
        continue;
      }
      plans.push({ unitName, plan: planResync(existing, unitId, await session.current.members(unitId)) });
    }
    setStep({ at: "resync", plans, missing });
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
      if (source.kind === "resync") {
        await loadResync(units);
        setBusy(false);
        return;
      }
      if (units.length === 0) throw new Error("Terrain doesn't list you as a leader of any unit, so there are no members to import.");
      setBusy(false);
      if (units.length === 1) await loadUnit(units[0]);
      else setStep({ at: "units", units });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const title = source.kind === "csv" ? "Import from a spreadsheet" : source.kind === "resync" ? "Resync with Terrain" : "Import from Terrain";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <section className="card modal-card import-card" ref={cardRef} tabIndex={-1}>
        <button className="close-overlay" onClick={onClose} aria-label="Close">×</button>
        <h2>{title}</h2>

        {step.at === "signin" ? (
          <form className="stack" onSubmit={(e) => void signIn(e)}>
            <p className="muted">
              {source.kind === "resync"
                ? "Log in to Terrain to bring your Terrain patrols up to date with who's in them now."
                : "Log in with your Scouts Australia member number and Terrain password to bring in your unit's youth, grouped by their patrol."}
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
            unit={step.unit}
            defaultName={step.defaultName}
            skipped={step.skipped}
            existing={existing}
            isCsv={source.kind === "csv"}
            onCancel={onClose}
            onImported={onImported}
          />
        ) : null}

        {step.at === "resync" ? <ResyncReview plans={step.plans} missing={step.missing} onCancel={onClose} onImported={onImported} /> : null}

        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}

function Review({
  racers: initialRacers,
  members,
  unit,
  defaultName,
  skipped,
  existing,
  isCsv,
  onCancel,
  onImported,
}: {
  racers: ImportedRacer[];
  members?: TerrainMember[];
  unit?: TerrainUnit;
  defaultName: string;
  skipped: string[];
  existing: RacePatrol[];
  isCsv: boolean;
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
  const [replaceAll, setReplaceAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const hasLeaders = (members ?? []).some((m) => m.unit?.duty === "adult_leader");

  const plan = useMemo(
    () =>
      planPatrols(racers, { split, name, existing: replaceAll ? [] : existing.map((p) => ({ id: p.id, name: p.name })) }),
    [racers, split, name, existing, replaceAll],
  );
  const save = async () => {
    if (plan.length === 0) return;
    const tooBig = plan.find((p) => p.racers.length > 300);
    if (tooBig) return setError(`${tooBig.name} has ${tooBig.racers.length} racers; a patrol can hold 300.`);
    if (
      replaceAll &&
      !(await confirmAction({
        title: `Replace all ${plural(existing.length, "Race Patrol")}?`,
        message: "They're deleted, including any from Terrain, and this file's patrols take their place.",
        confirmLabel: "Replace patrols",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    setError("");
    try {
      const patrols: SavedPatrol[] = plan.map((p) => ({
        name: p.name,
        racers: p.racers,
        existingId: p.existingId,
        source: unit ? "terrain" : "csv",
        terrain: unit
          ? {
              unitId: unit.id,
              unitName: unitLabel(unit),
              scope: !split ? "unit" : p.group ? "patrol" : "unpatrolled",
              patrol: split ? p.group : null,
              includeLeaders,
            }
          : undefined,
      }));
      onImported(`Imported ${plural(racers.length, "racer")}: ${await savePatrols(patrols, replaceAll)}`);
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
        {plural(racers.length, "racer")}
        {groups > 0 ? ` in ${plural(groups, "group")}` : ""}. Choose how to save them.
      </p>

      <div className="segmented" role="radiogroup" aria-label="How to save them">
        <button type="button" role="radio" aria-checked={split} className={split ? "on" : ""} onClick={() => setSplit(true)} disabled={groups === 0}>
          A patrol per group
        </button>
        <button type="button" role="radio" aria-checked={!split} className={!split ? "on" : ""} onClick={() => setSplit(false)}>
          One patrol for everyone
        </button>
      </div>

      {!split || plan.some((p) => !p.group) ? (
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

      {isCsv && existing.length > 0 ? (
        <label className={`check ${replaceAll ? "danger-check" : ""}`}>
          <input type="checkbox" checked={replaceAll} onChange={(e) => setReplaceAll(e.target.checked)} />
          Replace all my Race Patrols ({existing.length}) with this file
        </label>
      ) : null}
      {replaceAll ? (
        <p className="banner warning-banner" role="status">
          Your {plural(existing.length, "existing patrol")} will be deleted, including any from Terrain. Events you've
          already run keep their racers.
        </p>
      ) : null}

      <ul className="import-plan">
        {plan.map((p) => (
          <li key={p.name}>
            <div className="import-plan-head">
              <strong>{p.name}</strong>
              <span className={`status-badge ${p.existingId ? "in-progress" : "setup"}`}>{p.existingId ? "Updates existing" : "New"}</span>
              <span className="muted">{plural(p.racers.length, "racer")}</span>
            </div>
            <p className="import-plan-names">{p.racers.map((r) => r.name).join(", ")}</p>
          </li>
        ))}
      </ul>

      {skipped.length ? <SkippedRows rows={skipped} /> : null}

      <div className="wizard-actions">
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className={replaceAll ? "danger-solid" : ""} onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : replaceAll ? `Replace with ${plural(plan.length, "patrol")}` : `Save ${plural(plan.length, "patrol")}`}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

function ResyncReview({
  plans,
  missing,
  onCancel,
  onImported,
}: {
  plans: { unitName: string; plan: ResyncPlan }[];
  missing: string[];
  onCancel: () => void;
  onImported: (message: string) => void;
}) {
  const offered = plans.flatMap((p) => p.plan.newPatrols);
  const [addNew, setAddNew] = useState<Set<string>>(() => new Set(offered.map((n) => `${n.link.unitId}:${n.name}`)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const updates = plans.flatMap((p) => p.plan.updates);
  const changed = updates.filter((u) => u.added.length || u.removed.length).length;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const patrols: SavedPatrol[] = [
        ...updates.map((u) => ({ name: u.patrol.name, racers: u.racers, existingId: u.patrol.id, source: "terrain" as const, terrain: u.patrol.terrain! })),
        ...offered
          .filter((n) => addNew.has(`${n.link.unitId}:${n.name}`))
          .map((n) => ({ name: n.name, racers: n.racers, source: "terrain" as const, terrain: n.link })),
      ];
      await savePatrols(patrols);
      const added = patrols.length - updates.length;
      onImported(
        `Resynced with Terrain: ${changed ? plural(changed, "patrol") + " changed" : "no changes"}${added ? `, ${plural(added, "new patrol")}` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      {missing.length ? (
        <p className="banner warning-banner" role="status">
          Terrain doesn't list you as a leader of {missing.join(" or ")} any more, so {missing.length === 1 ? "its" : "their"} patrols
          are left as they are.
        </p>
      ) : null}
      {plans.length === 0 ? <p>There's nothing to resync.</p> : null}
      {plans.map(({ unitName, plan }) => (
        <div key={unitName} className="stack tight">
          <h3>{unitName}</h3>
          <ul className="import-plan">
            {plan.updates.map((u) => (
              <li key={u.patrol.id}>
                <div className="import-plan-head">
                  <strong>{u.patrol.name}</strong>
                  {u.added.length || u.removed.length ? (
                    <span className="status-badge in-progress">Changes</span>
                  ) : (
                    <span className="status-badge setup">Up to date</span>
                  )}
                  <span className="muted">{plural(u.racers.length, "racer")}</span>
                </div>
                {u.added.length ? <p className="sync-added">Joined: {u.added.join(", ")}</p> : null}
                {u.removed.length ? <p className="sync-removed">Left: {u.removed.join(", ")}</p> : null}
              </li>
            ))}
            {plan.emptied.map((p) => (
              <li key={p.id}>
                <div className="import-plan-head">
                  <strong>{p.name}</strong>
                  <span className="status-badge setup">Left as it is</span>
                </div>
                <p className="muted">Nobody is in this Terrain patrol now, so its racers stay as they were.</p>
              </li>
            ))}
            {plan.newPatrols.map((n) => {
              const key = `${n.link.unitId}:${n.name}`;
              return (
                <li key={key}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={addNew.has(key)}
                      onChange={(e) =>
                        setAddNew((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    <span>
                      Add <strong>{n.name}</strong>, new in Terrain ({plural(n.racers.length, "racer")})
                    </span>
                  </label>
                  <p className="import-plan-names">{n.racers.map((r) => r.name).join(", ")}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="wizard-actions">
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" onClick={() => void save()} disabled={saving || plans.length === 0}>
          {saving ? "Saving…" : "Update patrols"}
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
