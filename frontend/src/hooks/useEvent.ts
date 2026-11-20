import { useEffect, useState } from "react";
import { idToken } from "../shared/account";
import { api, isAuthRequiredError } from "../shared/api";
import { isQuiet, noteActivity, QUIET_LOOK_MS, socket, holdLiveConnection } from "../shared/socket";
import { kioskSessionStorageKey, removeLocalGuestEventId } from "../shared/storage";
import type { EventState } from "../shared/types";

export function useEvent(eventId?: string) {
  const [event, setEvent] = useState<EventState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!eventId) return;
    // What the event looked like last (all but when it was last used): a real change counts as race activity, keeping
    // the connection open or waking a quiet page; the same event sent again doesn't
    let seen: string | null = null;
    let lastFetch = 0;
    const take = (next: EventState) => {
      const now = JSON.stringify({ ...next, lastUsedAt: undefined });
      if (seen !== null && now !== seen) noteActivity();
      seen = now;
      setEvent(next);
    };
    const fetchEvent = () => {
      lastFetch = Date.now();
      api<EventState>(`/events/${eventId}?t=${Date.now()}`)
        .then(take)
        .catch((e: Error) => {
          if (isAuthRequiredError(e.message)) {
            removeLocalGuestEventId(eventId);
          }
          setError(e.message);
        });
    };

    fetchEvent();
    const release = holdLiveConnection();

    const subscribe = () => {
      void idToken().then((authToken) => {
        const kioskToken = window.localStorage.getItem(kioskSessionStorageKey);
        socket.emit("event:subscribe", { eventId, authToken, kioskToken });
      });
    };

    subscribe();
    const handler = (nextEvent: EventState) => {
      if (nextEvent.id === eventId) take(nextEvent);
    };
    const reconnectHandler = () => {
      subscribe();
      fetchEvent();
    };

    socket.on("event:update", handler);
    socket.on("connect", reconnectHandler);

    // The connection sends every change; asking the server only stands in while it's down (and the tab is in sight):
    // every 5 seconds if it dropped, every minute while it's quiet
    const pollId = window.setInterval(() => {
      if (socket.connected || document.hidden) return;
      if (isQuiet() && Date.now() - lastFetch < QUIET_LOOK_MS) return;
      fetchEvent();
    }, 5000);

    return () => {
      socket.off("event:update", handler);
      socket.off("connect", reconnectHandler);
      window.clearInterval(pollId);
      release();
    };
  }, [eventId]);

  return { event, error, setEvent };
}

