export function getApiOrigin(): string {
  const value = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

export const apiOrigin = getApiOrigin();

export function isAuthRequiredError(message: string): boolean {
  return message.toLowerCase().includes("authentication required to access this event");
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("auth_token");
  const kioskToken = localStorage.getItem("pinewood_kiosk_session");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (kioskToken) {
    headers["X-Kiosk-Token"] = kioskToken;
  }

  const base = apiOrigin.length > 0 ? apiOrigin : "";
  const res = await fetch(`${base}/api${path}`, {
    headers,
    cache: "no-store",
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "Request failed");
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

export async function copyToClipboardWithFallback(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("Copy this:", text);
  }
}

