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
      <section className="card success" style={{ textAlign: "center", padding: "4rem 2rem" }}>
        <h1>Pinewood Derby Control</h1>
        <p>Ready to start a new tournament?</p>
        <button onClick={startKiosk} disabled={loading} style={{ fontSize: "1.5rem", padding: "1rem 2rem" }}>
          {loading ? "Starting..." : "Create Guest Event"}
        </button>
        <p className="muted" style={{ marginTop: "2rem" }}>
          Guest events are temporary. <Link to="/login">Login</Link> to save your races permanently.
        </p>
      </section>
    </main>
  );
}

