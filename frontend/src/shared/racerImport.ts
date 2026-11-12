/*
  Racers brought in from elsewhere, for Race Patrols: a CSV file, or Terrain (see terrain.ts). Both end up
  as the same list of racers, which the import dialog then makes into one patrol or one per group.

  Pure functions only, so they're tested in racerImport.test.ts without a browser.
*/

export interface ImportedRacer {
  name: string;
  /** The racer's patrol, six or den; also how racers can be split into several Race Patrols */
  groupName?: string;
  weight?: number;
}

export interface CsvImport {
  racers: ImportedRacer[];
  /** Rows that were left out, and why, e.g. "Row 4: no name" */
  skipped: string[];
}

/** Reads CSV text into rows of cells: quoted cells, doubled quotes, commas, semicolons or tabs, any line ending */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = source.split(/\r\n|\n|\r/, 1)[0] ?? "";
  // Excel in some regions saves with semicolons; a pasted table has tabs
  const counts = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  const delimiter = counts.sort((a, b) => b.n - a.n)[0].n > 0 ? counts[0].d : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

const HEADINGS = {
  name: ["name", "racer", "racer name", "scout", "scout name", "full name", "member", "member name", "youth", "participant"],
  first: ["first name", "firstname", "given name", "first"],
  last: ["last name", "lastname", "surname", "family name", "last"],
  group: ["group", "patrol", "six", "den", "lodge", "team", "section", "unit", "group / patrol / den"],
  weight: ["weight", "weight (g)", "weight (oz)", "grams", "ounces", "car weight"],
} as const;

const heading = (cell: string) => cell.toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Racers from a CSV file. A first row of headings is recognised (Name, or First name and Last name; Group,
 * Patrol, Six or Den; Weight), in any order. Without one, the columns are taken as name, group, weight.
 */
export function racersFromCsv(text: string): CsvImport {
  const rows = parseCsv(text);
  if (rows.length === 0) return { racers: [], skipped: [] };

  const first = rows[0].map(heading);
  const find = (names: readonly string[]) => first.findIndex((cell) => names.includes(cell));
  const columns = {
    name: find(HEADINGS.name),
    first: find(HEADINGS.first),
    last: find(HEADINGS.last),
    group: find(HEADINGS.group),
    weight: find(HEADINGS.weight),
  };
  const hasHeadings = Object.values(columns).some((i) => i >= 0);
  if (!hasHeadings) Object.assign(columns, { name: 0, group: 1, weight: 2 });

  const racers: ImportedRacer[] = [];
  const skipped: string[] = [];
  rows.slice(hasHeadings ? 1 : 0).forEach((row, index) => {
    const rowNumber = index + (hasHeadings ? 2 : 1);
    const at = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const name =
      at(columns.name) || [at(columns.first), at(columns.last)].filter(Boolean).join(" ");
    if (!name) {
      skipped.push(`Row ${rowNumber}: no name`);
      return;
    }
    const racer: ImportedRacer = { name: name.slice(0, 120) };
    const group = at(columns.group);
    if (group) racer.groupName = group.slice(0, 50);
    const weightText = at(columns.weight).replace(/[^\d.,-]/g, "").replace(",", ".");
    const weight = weightText ? Number(weightText) : NaN;
    if (Number.isFinite(weight) && weight > 0 && weight <= 10_000) racer.weight = weight;
    else if (at(columns.weight)) skipped.push(`Row ${rowNumber}: weight "${at(columns.weight)}" isn't a number, left blank`);
    racers.push(racer);
  });
  return { racers, skipped };
}

/** A CSV file to start from, with the headings racersFromCsv looks for */
export const CSV_TEMPLATE = "Name,Group,Weight\nAva Nguyen,Kookaburra,141.5\nLiam Smith,Possum,\n";

export interface PlannedPatrol {
  name: string;
  /** The group its racers share, or null for everyone (or everyone without a group) */
  group: string | null;
  racers: ImportedRacer[];
  /** An existing Race Patrol with this name, which the import updates rather than duplicating */
  existingId?: string;
}

/**
 * The Race Patrols an import makes: all the racers in one patrol, or one patrol per group (racers without
 * a group go in one named after the whole import). A patrol whose name matches an existing one, ignoring
 * case, replaces that one's racers.
 */
export function planPatrols(
  racers: ImportedRacer[],
  options: { split: boolean; name: string; existing: { id: string; name: string }[] },
): PlannedPatrol[] {
  const fallback = options.name.trim() || "Imported racers";
  const groups = new Map<string, ImportedRacer[]>();
  const groupOf = new Map<string, string | null>();
  for (const racer of racers) {
    const grouped = options.split && racer.groupName ? racer.groupName : null;
    const key = grouped ?? fallback;
    groups.set(key, [...(groups.get(key) ?? []), racer]);
    if (!groupOf.has(key) || grouped === null) groupOf.set(key, grouped);
  }
  const existing = new Map(options.existing.map((p) => [p.name.trim().toLowerCase(), p.id]));
  return [...groups.entries()]
    .sort(([a], [b]) => (a === fallback ? 1 : b === fallback ? -1 : a.localeCompare(b)))
    .map(([name, list]) => ({
      name: name.slice(0, 80),
      group: groupOf.get(name) ?? null,
      racers: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      existingId: existing.get(name.trim().toLowerCase()),
    }));
}

/** How many distinct groups the racers are in */
export const groupCount = (racers: ImportedRacer[]) =>
  new Set(racers.map((r) => r.groupName).filter(Boolean)).size;
