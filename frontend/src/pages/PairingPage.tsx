import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../shared/api";
import { kioskSessionStorageKey } from "../shared/storage";
import type { EventState } from "../shared/types";

export function PairingPage() {
  const { qrToken } = useParams();
  const navigate = useNavigate();
  const [pairingCode, setPairingCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (codeToUse?: string) => {
      const code = codeToUse ?? pairingCode;
      if (!qrToken || code.length !== 6) return;
      setLoading(true);
      setError("");

      try {
        const res = await api<{ token: string; eventId: string | null }>("/kiosk/pair", {
          method: "POST",
          body: JSON.stringify({ qrToken, pairingCode: code }),
        });

        window.localStorage.setItem(kioskSessionStorageKey, res.token);
        if (res.eventId) {
          const event = await api<EventState>(`/events/${res.eventId}`);
          if (event.setupComplete) {
            navigate(`/control/${res.eventId}`);
          } else {
            navigate(`/configure/${res.token}`);
          }
        } else {
          navigate("/events");
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [qrToken, pairingCode, navigate]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && code.length === 6 && qrToken) {
      setPairingCode(code);
      void handleSubmit(code);
    }
  }, [qrToken, handleSubmit]);

  useEffect(() => {
    if (pairingCode.length === 6) {
      void handleSubmit();
    }
  }, [pairingCode, handleSubmit]);

  return (
    <main className="home-page">
      <section className="card">
        <h1>Pair with Kiosk</h1>
        <p>Enter the 6-digit code displayed on the kiosk screen.</p>
        <form onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }} className="stack">
          <label>
            Pairing Code
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              autoFocus
              required
              disabled={loading}
              className="pairing-input"
            />
          </label>
          {loading ? <p className="muted" style={{ textAlign: "center" }}>Linking device...</p> : null}
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

