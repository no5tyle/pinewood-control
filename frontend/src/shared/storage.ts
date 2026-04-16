const guestEventStorageKey = "pinewood_guest_event_ids";
const guestAccessUrlStorageKey = "pinewood_guest_access_urls";

export const quickStartDismissedStorageKey = "pinewood_quickstart_dismissed_v1";
export const kioskSessionStorageKey = "pinewood_kiosk_session";

export function safeParseStorageJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getLocalGuestEventIds(): string[] {
  const ids = safeParseStorageJSON<string[]>(window.localStorage.getItem(guestEventStorageKey), []);
  return ids.filter((id) => typeof id === "string" && id.length > 0);
}

export function setLocalGuestEventIds(ids: string[]) {
  const normalized = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  const currentNormalized = Array.from(new Set(getLocalGuestEventIds()));
  if (normalized.length === currentNormalized.length && normalized.every((id, idx) => id === currentNormalized[idx])) {
    return;
  }
  window.localStorage.setItem(guestEventStorageKey, JSON.stringify(normalized));
  window.dispatchEvent(new Event("pinewood:guest-events-changed"));
}

export function addLocalGuestEventId(eventId: string) {
  setLocalGuestEventIds([...getLocalGuestEventIds(), eventId]);
}

export function removeLocalGuestEventId(eventId: string) {
  setLocalGuestEventIds(getLocalGuestEventIds().filter((id) => id !== eventId));
}

export function getStoredGuestAccessUrls(): Record<string, { url: string; expiresAt: number }> {
  const raw = safeParseStorageJSON<Record<string, { url?: unknown; expiresAt?: unknown }>>(
    window.localStorage.getItem(guestAccessUrlStorageKey),
    {}
  );
  const now = Date.now();
  const out: Record<string, { url: string; expiresAt: number }> = {};
  for (const [eventId, value] of Object.entries(raw)) {
    const url = typeof value?.url === "string" ? value.url : "";
    const expiresAt = typeof value?.expiresAt === "number" ? value.expiresAt : 0;
    if (!eventId || !url || !expiresAt || expiresAt <= now) continue;
    out[eventId] = { url, expiresAt };
  }
  return out;
}

export function setStoredGuestAccessUrls(value: Record<string, { url: string; expiresAt: number }>) {
  window.localStorage.setItem(guestAccessUrlStorageKey, JSON.stringify(value));
}

