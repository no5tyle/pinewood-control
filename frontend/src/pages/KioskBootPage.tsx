import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { api } from "../shared/api";
import { kioskSessionStorageKey } from "../shared/storage";

export function KioskBootPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const startKiosk = async () => {
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/kiosk/bootstrap", { method: "POST" });
      window.localStorage.setItem(kioskSessionStorageKey, res.token);
      navigate(`/kiosk/new`);
    } catch {
      setLoading(false);
    }
  };

  if (user) {
    return <Navigate to="/events" replace />;
  }

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card hero-card">
        <h1>Run your pinewood derby</h1>
        <p className="hero-lede">
          A big screen shows each heat and the standings. A phone runs the races: tap the finishers, and the
          next heat is drawn for you.
        </p>
        <div className="hero-actions">
          <button onClick={startKiosk} disabled={loading}>
            {loading ? "Starting…" : "Start a guest event"}
          </button>
          <Link to="/login" className="secondary-link">Log in</Link>
        </div>
        <p className="fine-print">
          Guest events belong to this device and are deleted after 24 hours. <Link to="/signup">Create an account</Link>{" "}
          to keep your events and reuse Race Patrols.
        </p>
      </section>

      <section className="steps" aria-label="How it works">
        <div className="step card">
          <span className="step-number">1</span>
          <h2>Open the kiosk</h2>
          <p className="muted">On the laptop or TV everyone can see. It shows a QR code to pair a phone.</p>
        </div>
        <div className="step card">
          <span className="step-number">2</span>
          <h2>Pair a phone</h2>
          <p className="muted">Scan the code and enter the 6 digits. Set up lanes, points and racers from the phone.</p>
        </div>
        <div className="step card">
          <span className="step-number">3</span>
          <h2>Race</h2>
          <p className="muted">Tap the cars in finishing order. Late entrants, drop-outs and a popular vote are covered.</p>
        </div>
      </section>
    </main>
  );
}
