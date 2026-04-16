import { useEffect, useRef } from "react";
import { useAuth } from "../AuthContext";
import { api, isAuthRequiredError } from "../shared/api";
import { guestClaimStatusEventName } from "../shared/events";
import { getLocalGuestEventIds, setLocalGuestEventIds } from "../shared/storage";

export function ClaimLocalGuestEventsOnAuth() {
  const { user } = useAuth();
  const attemptRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const userId = user?.id ?? null;
    if (!userId) return;

    attemptRef.current = 0;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);

    const claimOnce = async () => {
      const ids = getLocalGuestEventIds();
      if (ids.length === 0) return;

      window.dispatchEvent(
        new CustomEvent(guestClaimStatusEventName, { detail: { inProgress: true, remaining: ids.length } })
      );

      const results = await Promise.allSettled(ids.map((eventId) => api(`/events/${eventId}/claim`, { method: "POST" })));
      const remaining: string[] = [];
      let succeeded = 0;
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          succeeded += 1;
          return;
        }
        const message = (r.reason as Error | undefined)?.message ?? "";
        if (message.includes("Event not found") || message.includes("Event already claimed") || isAuthRequiredError(message)) return;
        remaining.push(ids[idx]);
      });

      setLocalGuestEventIds(remaining);
      if (succeeded > 0) {
        window.dispatchEvent(new Event("pinewood:guest-events-claimed"));
      }

      window.dispatchEvent(
        new CustomEvent(guestClaimStatusEventName, {
          detail: { inProgress: remaining.length > 0, remaining: remaining.length },
        })
      );

      attemptRef.current += 1;
      if (remaining.length > 0 && attemptRef.current < 4) {
        timeoutRef.current = window.setTimeout(() => {
          void claimOnce().catch(() => undefined);
        }, 5000);
      }
    };

    void claimOnce().catch(() => undefined);

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  return null;
}

