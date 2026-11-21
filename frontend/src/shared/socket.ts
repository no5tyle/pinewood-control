import socketIOClient from "socket.io-client";
import { apiOrigin } from "./api";

/*
 * The live connection to the race server, for the pages that follow an event as it happens (Race Control, the kiosk
 * and big screen, Add Scouts). Cloud Run bills for every second a connection is open, so it's open only while it's
 * earning its keep:
 *  - only while one of those pages is showing;
 *  - not once the tab has been out of sight for 15 minutes;
 *  - not once there's been no race activity (no change to the event, no tap or key) for 30 minutes. (The event as
 *    it was, sent again on each reconnect, isn't a change.) A big screen left
 *    on overnight goes quiet: it asks for the event once a minute instead (a moment's work each), and as soon as
 *    something changes (a heat is run, a scout added) or someone touches it, the connection opens again.
 */
// `v: 2`: a page that keeps its connection short (the server closes older pages' connections straight away)
export const socket = socketIOClient(apiOrigin || "/", { autoConnect: false, auth: { v: 2 } });

const AWAY_AFTER_MS = 15 * 60_000;
const QUIET_AFTER_MS = 30 * 60_000;
/** How often a quiet page asks for the event. */
export const QUIET_LOOK_MS = 60_000;

let users = 0;
let awayTimer: number | undefined;
let quietTimer: number | undefined;
let quiet = false;

/** Whether the connection is closed for want of activity (the pages ask for the event once a minute meanwhile). */
export const isQuiet = () => quiet;

const open = () => {
  if (users > 0 && !document.hidden && !quiet && !socket.connected) socket.connect();
};

/** Something happened (a change to the event, a tap or a key): stay connected, or connect again if quiet. */
export function noteActivity() {
  window.clearTimeout(quietTimer);
  quietTimer = window.setTimeout(() => {
    quiet = true;
    socket.disconnect();
  }, QUIET_AFTER_MS);
  if (quiet) {
    quiet = false;
    open();
  }
}

/** A page that follows an event live starts using the connection; call the answer when it stops. */
export function holdLiveConnection(): () => void {
  users++;
  noteActivity();
  open();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users--;
    if (users === 0) {
      socket.disconnect();
      window.clearTimeout(quietTimer);
      quiet = false;
    }
  };
}

for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => { if (users > 0) noteActivity(); }, { passive: true, capture: true });

// The server closes a connection with nothing happening (30 minutes): go quiet, looking once a minute until something does
socket.on("disconnect", (reason) => {
  if (reason === "io server disconnect" && users > 0) quiet = true;
});

// Out of sight for 15 minutes: close it; back in sight: open it again (the pages fetch what they missed on connect)
document.addEventListener("visibilitychange", () => {
  window.clearTimeout(awayTimer);
  if (document.hidden) awayTimer = window.setTimeout(() => socket.disconnect(), AWAY_AFTER_MS);
  else open();
});
