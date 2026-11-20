import { useEffect, useState } from "react";
import { idToken } from "../shared/account";
import { api, isAuthRequiredError } from "../shared/api";
import { socket, holdLiveConnection } from "../shared/socket";
import { kioskSessionStorageKey, removeLocalGuestEventId } from "../shared/storage";
import type { EventState } from "../shared/types";

export function useEvent(eventId?: string) {
  const [event, setEvent] = useState<EventState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!eventId) return;
    const fetchEvent = () => {
      api<EventState>(`/events/${eventId}?t=${Date.now()}`)
        .then(setEvent)
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
      if (nextEvent.id === eventId) setEvent(nextEvent);
    };
    const reconnectHandler = () => {
      subscribe();
      fetchEvent();
    };

    socket.on("event:update", handler);
    socket.on("connect", reconnectHandler);

    // The connection sends every change; asking the server only stands in while it's down (and the tab is in sight)
    const pollId = window.setInterval(() => {
      if (!socket.connected && !document.hidden) fetchEvent();
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

