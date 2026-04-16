import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { quickStartOpenEventName } from "../shared/events";
import { quickStartDismissedStorageKey } from "../shared/storage";

export function QuickStartOverlay() {
  const navigate = useNavigate();
  const location = useLocation();
  const [forcedOpen, setForcedOpen] = useState(false);

  const close = useCallback(() => {
    window.localStorage.setItem(quickStartDismissedStorageKey, "1");
    setForcedOpen(false);
  }, []);

  const dismissed = window.localStorage.getItem(quickStartDismissedStorageKey) === "1";
  const autoOpen = !dismissed && (location.pathname === "/" || location.pathname === "/events");
  const open = forcedOpen || autoOpen;

  useEffect(() => {
    const onOpen = () => setForcedOpen(true);
    window.addEventListener(quickStartOpenEventName, onOpen);
    return () => window.removeEventListener(quickStartOpenEventName, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="quickstart-overlay" role="dialog" aria-modal="true" aria-label="Quick start guide">
      <section className="card quickstart-card">
        <button className="close-overlay" onClick={close} aria-label="Close" autoFocus>×</button>
        <h2 style={{ margin: 0 }}>Quick Start</h2>
        <p className="muted" style={{ margin: 0 }}>
          Create an event, link an operator device, then run heats and submit results.
        </p>
        <ol className="quickstart-steps">
          <li>Create an event (guest or signed-in).</li>
          <li>Open the Kiosk on the display device.</li>
          <li>Link the operator device by scanning the QR and entering the pairing code.</li>
          <li>Add racers, generate heats, then submit the full finish order after each race.</li>
        </ol>
        <div className="quickstart-actions">
          <button className="secondary-btn" onClick={() => { close(); navigate("/help"); }}>More</button>
          <div style={{ flex: 1 }} />
          <button onClick={close}>Get Started</button>
        </div>
      </section>
    </div>
  );
}

