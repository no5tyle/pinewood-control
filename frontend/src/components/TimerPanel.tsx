import type { TimerApi } from "../hooks/useTimer";

const phaseText: Record<TimerApi["phase"], string> = {
  waiting: "Waiting to be readied for the heat.",
  ready: "Ready: the race starts when the gate drops.",
  gateOpen: "The start gate is open. Close it, then press Ready timer.",
  racing: "Racing…",
  finished: "Finished: the times are in the finish order below. Check it, then submit.",
};

/** The electronic timer add-on's card on Race Control */
export function TimerPanel({ timer, eventLanes, hasHeat, onReady }: {
  timer: TimerApi;
  eventLanes: number;
  hasHeat: boolean;
  onReady: () => void;
}) {
  const status = timer.connected
    ? ["Connected", timer.version ? `PDT ${timer.version}` : null, timer.lanes ? `${timer.lanes} lanes` : null].filter(Boolean).join(" · ")
    : "Not connected";

  return (
    <section className="card timer-card">
      <div className="card-head">
        <h2>Electronic timer</h2>
        <span className={`timer-status ${timer.connected ? "on" : ""}`}>
          <span className="timer-dot" aria-hidden="true" />
          {status}
        </span>
      </div>

      {!timer.supported ? (
        <p className="muted">
          Connecting a timer needs Chrome or Edge on a computer: they're the browsers that can use a USB serial port.
          Open Race Control there, with the timer plugged in.
        </p>
      ) : !timer.connected ? (
        <>
          <p className="muted">
            Plug a PDT-compatible timer (such as pinewood-time) into this computer by USB, then connect to it. Its times fill
            in each heat's finish order.
          </p>
          <div className="inline-actions">
            <button type="button" onClick={() => void timer.connect()} disabled={timer.connecting}>
              {timer.connecting ? "Connecting…" : "Connect timer"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={`timer-phase phase-${timer.phase}`}>{hasHeat ? phaseText[timer.phase] : "Generate a heat to race."}</p>
          {timer.lanes && timer.lanes < eventLanes ? (
            <p className="error">
              The timer is set up for {timer.lanes} lanes but this event has {eventLanes}. Lanes past {timer.lanes} won't get times.
            </p>
          ) : null}
          {timer.isPinewoodTime ? (
            <p className="muted">The timer's button submits each heat's result and generates the next heat.</p>
          ) : null}
          <div className="inline-actions">
            <button type="button" onClick={onReady} disabled={!hasHeat || timer.phase === "racing"}>
              Ready timer
            </button>
            <button type="button" className="secondary-btn" onClick={() => void timer.resend()} disabled={!hasHeat}>
              Get results again
            </button>
            <button type="button" className="secondary-btn" onClick={() => void timer.disconnect()}>
              Disconnect
            </button>
          </div>
          {timer.log.length > 0 ? (
            <details className="help-details">
              <summary>Timer messages</summary>
              <pre className="timer-log">{timer.log.join("\n")}</pre>
            </details>
          ) : null}
        </>
      )}

      {timer.error ? <p className="error">{timer.error}</p> : null}
      <p className="muted timer-off">
        <button type="button" className="text-btn" onClick={() => timer.setEnabled(false)}>Turn off the timer add-on</button>
      </p>
    </section>
  );
}
