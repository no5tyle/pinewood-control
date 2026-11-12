import { useEffect, useRef, useState } from "react";
import { registerConfirmHost, type ConfirmRequest } from "../shared/confirm";

/** Draws the confirmAction() dialog. Mounted once, in App */
export function ConfirmHost() {
  const [request, setRequest] = useState<(ConfirmRequest & { answer: (ok: boolean) => void }) | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerConfirmHost((req, answer) => setRequest({ ...req, answer }));
    return () => registerConfirmHost(null);
  }, []);

  const close = (ok: boolean) => {
    request?.answer(ok);
    setRequest(null);
  };

  useEffect(() => {
    if (!request) return;
    // Something that can't be undone starts on Cancel, so Enter doesn't delete by accident
    (request.danger ? cancelRef : confirmRef).current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;
  return (
    <div className="modal-overlay confirm-overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <section className="card modal-card confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={request.message ? "confirm-text" : undefined}>
        <h2 id="confirm-title">{request.title}</h2>
        {request.message ? <p id="confirm-text" className="muted">{request.message}</p> : null}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="secondary-btn" onClick={() => close(false)}>Cancel</button>
          <button ref={confirmRef} type="button" className={request.danger ? "danger-solid" : ""} onClick={() => close(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
