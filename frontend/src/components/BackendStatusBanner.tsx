import { useEffect, useRef, useState } from "react";
import appConfig from "../appConfig.json";
import { apiOrigin } from "../shared/api";

type BackendStatus = "unknown" | "online" | "offline";

export function BackendStatusBanner() {
  const [status, setStatus] = useState<BackendStatus>("unknown");
  const failCountRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const check = async () => {
      const base = apiOrigin || "";
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(`${base}/api/health`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error("bad status");
        failCountRef.current = 0;
        setStatus("online");
      } catch {
        failCountRef.current += 1;
        if (failCountRef.current >= 2) setStatus("offline");
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    void check();
    timerRef.current = window.setInterval(() => {
      void check();
    }, 10_000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  const supportUrl = typeof (appConfig as any).supportUrl === "string" ? String((appConfig as any).supportUrl) : "";
  const supportLabel = typeof (appConfig as any).supportLabel === "string" ? String((appConfig as any).supportLabel) : "Contact support";
  const url = supportUrl.trim();

  if (status !== "offline") return null;

  return (
    <div className="backend-status-banner" role="status" aria-label="Server status">
      <span>
        Server connection lost.
        {url.length > 0 ? (
          <>
            {" "}If this continues:{" "}
            <a href={url} target="_blank" rel="noreferrer">
              {supportLabel}
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}
