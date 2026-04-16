/*
  Small shared utilities used across routes and services.

  Usage:
  - safeParseJSON: decode JSON stored in DB string fields.
  - shuffle: randomize assignments (e.g. random car number distribution for patrol imports).
  - nextAvailableCarNumbers: allocate the next free car numbers, reusing gaps after deletions.
  - sleep: small async delay helper.
*/
export function safeParseJSON<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

export function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// Returns the lowest available positive integer car numbers not currently used in the event.
// This intentionally reuses gaps created by removing racers so numbering stays compact and stable.
export function nextAvailableCarNumbers(existing: Array<{ carNumber: string }>, count: number): string[] {
  const used = new Set<number>();
  existing.forEach((s) => {
    const n = Number.parseInt(s.carNumber, 10);
    if (Number.isFinite(n) && n > 0) used.add(n);
  });

  const out: string[] = [];
  for (let n = 1; out.length < count; n += 1) {
    if (!used.has(n)) out.push(String(n));
  }
  return out;
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
