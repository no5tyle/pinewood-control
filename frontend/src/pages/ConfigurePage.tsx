import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { api } from "../shared/api";
import { removeLocalGuestEventId } from "../shared/storage";
import type { EventState, KioskSessionStatus, ThemeName } from "../shared/types";

export function ConfigurePage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const { user } = useAuth();
  const [session, setSession] = useState<KioskSessionStatus | null>(null);
  const [event, setEvent] = useState<EventState | null>(null);
  const [pointLimit, setPointLimit] = useState<string>("10");
  const [lanes, setLanes] = useState<string>("4");
  const [theme, setTheme] = useState<ThemeName>("system");
  const [weightUnit, setWeightUnit] = useState<"g" | "oz">("g");
  const [error, setError] = useState("");
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (!token) return;
    api<KioskSessionStatus>(`/kiosk/sessions/${token}`)
      .then((s) => {
        setSession(s);
        if (!s.eventId) throw new Error("No event linked to this kiosk session.");
        return api<EventState>(`/events/${s.eventId}`);
      })
      .then((e) => {
        if (e.setupComplete) {
          navigate(`/control/${e.id}`, { replace: true });
          return;
        }
        setEvent(e);
        setPointLimit(String(e.pointLimit));
        setLanes(String(e.lanes));
        setTheme(e.theme as ThemeName);
        setWeightUnit(e.weightUnit === "oz" ? "oz" : "g");
      })
      .catch((err: Error) => setError(err.message));
  }, [token, navigate]);

  const saveAndNext = async (e: FormEvent) => {
    e.preventDefault();
    if (!session?.eventId) return;

    if (step === 1) return;

    if (step === 2) {
      const lanesNum = Number(lanes);
      if (!Number.isFinite(lanesNum) || lanes.trim().length === 0) {
        setError("Please enter the number of lanes.");
        return;
      }
      if (lanesNum < 2 || lanesNum > 12) {
        setError("Lanes must be between 2 and 12.");
        return;
      }
      setError("");
      setStep(3);
      return;
    }

    try {
      const lanesNum = Number(lanes);
      if (!Number.isFinite(lanesNum) || lanes.trim().length === 0) {
        setError("Please enter the number of lanes.");
        return;
      }
      if (lanesNum < 2 || lanesNum > 12) {
        setError("Lanes must be between 2 and 12.");
        return;
      }

      const pointLimitNum = Number(pointLimit);
      if (!Number.isFinite(pointLimitNum) || pointLimit.trim().length === 0) {
        setError("Please enter the elimination points.");
        return;
      }
      if (pointLimitNum < 1 || pointLimitNum > 200) {
        setError("Elimination points must be between 1 and 200.");
        return;
      }

      await api<EventState>(`/events/${session.eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ pointLimit: pointLimitNum, lanes: lanesNum, theme, weightUnit }),
      });
      navigate(`/events/${session.eventId}/scouts`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const claimEvent = async () => {
    if (!session?.eventId) return;
    try {
      await api(`/events/${session.eventId}/claim`, { method: "POST" });
      removeLocalGuestEventId(session.eventId);
      const updated = await api<EventState>(`/events/${session.eventId}`);
      setEvent(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!session || !event) return <main className="home-page"><p>{error || "Loading setup..."}</p></main>;

  return (
    <main className="home-page">
      <h1>Configure Event</h1>
      <p className="muted">Setup your tournament parameters.</p>
      {event.isGuest && !user ? (
        <div className="banner info desktop-only">
          This is a guest event. <Link to="/login">Login</Link> or <Link to="/signup">Signup</Link> to save it to your account.
        </div>
      ) : null}
      {event.isGuest && user ? (
        <div className="banner info desktop-only">
          This is a guest event. <button onClick={() => void claimEvent()} className="text-btn">Save to my account</button>
        </div>
      ) : null}
      <div className="wizard-steps">
        <div className={`wizard-step ${step === 1 ? "active" : step > 1 ? "completed" : ""}`}>1. Theme</div>
        <div className={`wizard-step ${step === 2 ? "active" : step > 2 ? "completed" : ""}`}>2. Lanes</div>
        <div className={`wizard-step ${step === 3 ? "active" : step > 3 ? "completed" : ""}`}>3. Points</div>
      </div>

      <form className="card" onSubmit={saveAndNext}>
        {step === 1 ? (
          <>
            <h2>Tournament Theme</h2>
            <p className="muted">Select a theme to continue.</p>
            <div className="unit-toggle">
              <button
                type="button"
                className={`secondary-btn ${weightUnit === "g" ? "active" : ""}`}
                onClick={() => setWeightUnit("g")}
              >
                grams
              </button>
              <button
                type="button"
                className={`secondary-btn ${weightUnit === "oz" ? "active" : ""}`}
                onClick={() => setWeightUnit("oz")}
              >
                ounces
              </button>
              <span className="muted">Weight unit</span>
            </div>
            <div className="theme-grid">
              <button
                type="button"
                className="theme-btn"
                data-theme="system"
                onClick={() => {
                  setTheme("system");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="system" />
                <div className="theme-title">System</div>
                <div className="theme-subtitle">System</div>
              </button>
              <button
                type="button"
                className="theme-btn"
                data-theme="scouts-au-cubs"
                onClick={() => {
                  setTheme("scouts-au-cubs");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="scouts-au-cubs" />
                <div className="theme-title">Cubs Australia</div>
                <div className="theme-subtitle">Cubs Australia</div>
              </button>
              <button
                type="button"
                className="theme-btn"
                data-theme="scouts-america"
                onClick={() => {
                  setTheme("scouts-america");
                  setError("");
                  setStep(2);
                }}
              >
                <div className="theme-swatch" data-theme="scouts-america" />
                <div className="theme-title">BSA</div>
                <div className="theme-subtitle">BSA</div>
              </button>
            </div>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <h2>Track Lanes</h2>
            <p className="muted">Enter your track lane count.</p>
            <label>
              How many lanes does your track have?
              <input type="number" min={2} max={12} value={lanes} onChange={(e) => setLanes(e.target.value)} autoFocus />
            </label>
          </>
        ) : null}
        {step === 3 ? (
          <>
            <h2>Elimination Points</h2>
            <p className="muted">Lower numbers eliminate racers faster.</p>
            <label>
              How many points before a racer is eliminated?
              <input type="number" min={1} max={200} value={pointLimit} onChange={(e) => setPointLimit(e.target.value)} autoFocus />
            </label>
          </>
        ) : null}

        {step > 1 ? (
          <div className="wizard-actions">
            <button type="button" className="secondary-btn" onClick={() => setStep(step - 1)}>Back</button>
            <div style={{ flex: 1 }} />
            <button type="submit">{step === 3 ? "Continue to contestants" : "Next"}</button>
          </div>
        ) : null}
      </form>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

