import { useCallback, useEffect, useState } from "react";
import { donateOpenEventName } from "../shared/events";

export function DonateOverlay() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(donateOpenEventName, onOpen);
    return () => window.removeEventListener(donateOpenEventName, onOpen);
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
    <div className="quickstart-overlay" role="dialog" aria-modal="true" aria-label="Support Pinewood Controller">
      <section className="card quickstart-card">
        <button className="close-overlay" onClick={close} aria-label="Close" autoFocus>×</button>
        <h2 style={{ margin: 0 }}>Support this project</h2>
        <p className="muted" style={{ margin: 0 }}>
          Donations are used to cover server hosting and, beyond that, other scouting-related things.
        </p>
        <div className="donate-link-card">
          <div className="donate-link-title">ko-fi.com/nostyle</div>
          <a className="donate-link-btn" href="https://ko-fi.com/nostyle" target="_blank" rel="noreferrer">
            Donate on Ko-fi
          </a>
        </div>
        <div className="quickstart-actions">
          <div style={{ flex: 1 }} />
          <button onClick={close}>Close</button>
        </div>
      </section>
    </div>
  );
}

