import { useEffect, useState } from "react";
import { api, isAuthRequiredError } from "../shared/api";
import { socket } from "../shared/socket";
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

    const subscribe = () => {
      const authToken = window.localStorage.getItem("auth_token");
      const kioskToken = window.localStorage.getItem(kioskSessionStorageKey);
      socket.emit("event:subscribe", { eventId, authToken, kioskToken });
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

    const pollId = window.setInterval(fetchEvent, 1500);

    return () => {
      socket.off("event:update", handler);
      socket.off("connect", reconnectHandler);
      window.clearInterval(pollId);
    };
  }, [eventId]);

  return { event, error, setEvent };
}

