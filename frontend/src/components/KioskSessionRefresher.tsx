import { useEffect, useRef } from "react";
import { api } from "../shared/api";
import { kioskSessionStorageKey } from "../shared/storage";

export function KioskSessionRefresher() {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const refresh = async () => {
      const token = window.localStorage.getItem(kioskSessionStorageKey);
      if (!token) return;
      try {
        await api("/kiosk/sessions/refresh", { method: "POST" });
      } catch (e) {
        const message = (e as Error).message ?? "";
        if (message.toLowerCase().includes("session expired") || message.toLowerCase().includes("session not found")) {
          window.localStorage.removeItem(kioskSessionStorageKey);
        }
      }
    };

    void refresh();
    timerRef.current = window.setInterval(() => {
      void refresh();
    }, 30 * 60_000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  return null;
}

