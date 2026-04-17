import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../shared/api";
import { kioskSessionStorageKey } from "../shared/storage";

export function GuestKioskRedeemPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    api<{ token: string; eventId: string | null; expiresAt: number }>(`/guest-kiosk/${token}`, { method: "POST" })
      .then((res) => {
        window.localStorage.setItem(kioskSessionStorageKey, res.token);
        if (!res.eventId) throw new Error("No event linked to this access token");
        navigate(`/kiosk/${res.eventId}`, { replace: true });
      })
      .catch((e: Error) => setError(e.message));
  }, [token, navigate]);

  return (
    <main className="home-page auth-required-page">
      <section className="card auth-required-card">
        <h1>Opening Guest Kiosk…</h1>
        {error ? <p className="error">{error}</p> : <p className="muted">Please wait.</p>}
        <div className="auth-required-actions">
          <button className="secondary-btn" onClick={() => navigate("/")}>Home</button>
        </div>
      </section>
    </main>
  );
}

