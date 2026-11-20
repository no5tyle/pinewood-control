import socketIOClient from "socket.io-client";
import { apiOrigin } from "./api";

/*
 * The live connection to the race server, for the pages that follow an event as it happens (Race Control, the kiosk
 * and big screen, Add Scouts). It's opened only while one of them is showing, and closed when the last one goes or
 * the tab has been out of sight for 15 minutes: Cloud Run bills for every second a connection is open, so one left
 * open from any page (as it once was) kept the server billed all day.
 */
export const socket = socketIOClient(apiOrigin || "/", { autoConnect: false });

const AWAY_AFTER_MS = 15 * 60_000;
let users = 0;
let awayTimer: number | undefined;

/** A page that follows an event live starts using the connection; call the answer when it stops. */
export function holdLiveConnection(): () => void {
  users++;
  if (!document.hidden) socket.connect();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users--;
    if (users === 0) socket.disconnect();
  };
}

// Out of sight for 15 minutes: close it; back in sight: open it again (the pages fetch what they missed on connect)
document.addEventListener("visibilitychange", () => {
  window.clearTimeout(awayTimer);
  if (document.hidden) {
    awayTimer = window.setTimeout(() => socket.disconnect(), AWAY_AFTER_MS);
  } else if (users > 0 && !socket.connected) {
    socket.connect();
  }
});
