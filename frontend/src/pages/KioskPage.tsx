import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import { AuthRequiredPage } from "../components/AuthRequiredPage";
import { useEvent } from "../hooks/useEvent";
import { api, copyToClipboardWithFallback, isAuthRequiredError } from "../shared/api";
import { socket } from "../shared/socket";
import { getQrPrefix } from "../shared/qr";
import { addLocalGuestEventId, kioskSessionStorageKey, removeLocalGuestEventId } from "../shared/storage";
import type { EventState, KioskSessionStatus, Scout, ThemeName } from "../shared/types";

export function KioskPage() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { event, error, setEvent } = useEvent(eventId === "new" ? undefined : eventId);
  const [sessionToken, setSessionToken] = useState("");
  const [qrSrc, setQrSrc] = useState("");
  const [qrUrl, setQrUrl] = useState("");
  const [qrToken, setQrToken] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [showPairing, setShowPairing] = useState(true);
  const [newName, setNewName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [namingError, setNamingError] = useState("");
  const [previousWinner, setPreviousWinner] = useState<Scout | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);
  const [lastActiveHeatId, setLastActiveHeatId] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<"idle" | "copying" | "copied">("idle");
  const shareTimerRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isNewEvent = eventId === "new" || (event?.name === "New Pinewood Derby Event" && !event?.setupComplete);
  const kioskTheme = (event?.theme as ThemeName | undefined) ?? "system";

  useEffect(() => {
    return () => {
      if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showPairing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPairing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showPairing]);

  useEffect(() => {
    // Always keep nowMs “warm” so the popular vote countdown doesn't briefly show a stale number when reveal starts.
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const copyKioskLink = async () => {
    if (!event?.id) return;
    setShareStatus("copying");

    const base = getQrPrefix();
    let url = `${base}/kiosk/${event.id}`;
    if (user && !event.isGuest) {
      try {
        const res = await api<{ token: string; expiresAt: number }>(`/events/${event.id}/guest-kiosk-link`, { method: "POST" });
        url = `${base}/guest-kiosk/${res.token}`;
      } catch {
        void 0;
      }
    }

    await copyToClipboardWithFallback(url);

    setShareStatus("copied");
    if (shareTimerRef.current) window.clearTimeout(shareTimerRef.current);
    shareTimerRef.current = window.setTimeout(() => setShareStatus("idle"), 1500);
  };

  const claimEvent = async () => {
    if (!event?.id) return;
    try {
      await api(`/events/${event.id}/claim`, { method: "POST" });
      removeLocalGuestEventId(event.id);
      const updated = await api<EventState>(`/events/${event.id}`);
      setEvent(updated);
    } catch (err) {
      setNamingError((err as Error).message);
    }
  };

  const handleNameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const suggestedName = event?.name && event.name !== "New Pinewood Derby Event" ? event.name : "";
    const nameToSubmit = (nameTouched ? newName : suggestedName).trim();
    if (!nameToSubmit || !sessionToken) return;
    try {
      const res = await api<EventState>(`/kiosk/sessions/${sessionToken}/create-event`, {
        method: "POST",
        body: JSON.stringify({ name: nameToSubmit, lanes: 4, pointLimit: 10 }),
      });
      setEvent(res);
      if (!user || res.isGuest) addLocalGuestEventId(res.id);
      navigate(`/kiosk/${res.id}`, { replace: true });
      setNamingError("");
    } catch (err) {
      setNamingError((err as Error).message);
    }
  };

  useEffect(() => {
    const ensureSession = async () => {
      let token = window.localStorage.getItem(kioskSessionStorageKey);
      if (token) {
        try {
          const session = await api<KioskSessionStatus>(`/kiosk/sessions/${token}`);
          if (eventId !== "new" && session.eventId && session.eventId !== eventId) {
            token = null;
          }
        } catch {
          token = null;
        }
      }

      if (!token) {
        const created = await api<{ token: string }>("/kiosk/sessions", { method: "POST" });
        token = created.token;
        window.localStorage.setItem(kioskSessionStorageKey, token);
      }

      setSessionToken(token);
      if (eventId !== "new") {
        await api(`/kiosk/sessions/${token}/bind`, { method: "POST", body: JSON.stringify({ eventId }) }).catch(() => undefined);
      }
    };

    void ensureSession().catch((e: Error) => setSessionError(e.message));
  }, [eventId]);

  useEffect(() => {
    socket.on("kiosk:paired", () => setShowPairing(false));
    return () => {
      socket.off("kiosk:paired");
    };
  }, []);

  useEffect(() => {
    if (!sessionToken || isNewEvent || eventId === "new") return;

    const refreshPairing = () => {
      api<{ qrToken: string; pairingCode: string }>(`/kiosk/sessions/${sessionToken}/pairing-request`, {
        method: "POST",
      })
        .then((res) => {
          setQrToken(res.qrToken);
          setPairingCode(res.pairingCode);
          const url = `${getQrPrefix()}/pair/${res.qrToken}`;
          setQrUrl(url);
          return QRCode.toDataURL(url, { width: 320, margin: 1 });
        })
        .then(setQrSrc)
        .catch((e: Error) => setSessionError(`QR error: ${e.message}`));
    };

    refreshPairing();
    const interval = window.setInterval(refreshPairing, 110_000);
    return () => window.clearInterval(interval);
  }, [sessionToken, eventId, isNewEvent]);

  const currentHeat = useMemo(() => event?.heats?.find((h) => h.id === event.currentHeatId), [event]);
  const scoutMap = useMemo(() => new Map((event?.scouts ?? []).map((s) => [s.id, s])), [event?.scouts]);

  useEffect(() => {
    if (!event) return;
    if (event.isComplete) return;

    const justFinished = event.heats.find((h) => h.id === lastActiveHeatId && h.winnerScoutId);
    if (justFinished && !showWinnerOverlay) {
      const winner = scoutMap.get(justFinished.winnerScoutId!);
      if (winner) {
        setPreviousWinner(winner);
        setShowWinnerOverlay(true);
        setLastActiveHeatId(null);
      }
    }

    if (currentHeat?.id && currentHeat.id !== lastActiveHeatId && !showWinnerOverlay) {
      setLastActiveHeatId(currentHeat.id);
    }
  }, [event, currentHeat?.id, lastActiveHeatId, scoutMap, showWinnerOverlay]);

  useEffect(() => {
    if (showWinnerOverlay) {
      const timer = window.setTimeout(() => {
        setShowWinnerOverlay(false);
        setPreviousWinner(null);
      }, 5000);
      return () => window.clearTimeout(timer);
    }
  }, [showWinnerOverlay]);

  if (!eventId) return <Navigate to="/" replace />;
  if (error || sessionError) {
    const message = error || sessionError;
    if (isAuthRequiredError(message)) return <AuthRequiredPage message={message} />;
    return <main className="kiosk-page"><p className="error">{message}</p></main>;
  }
  if (!event && eventId !== "new") return <main className="kiosk-page"><p>Loading kiosk...</p></main>;

  return (
    <main className="kiosk-page" data-kiosk-theme={kioskTheme}>
      <AppHeader onRelink={() => setShowPairing(true)} />

      {isNewEvent ? (
        <div className="kiosk-naming-overlay">
          <section className="card" style={{ position: "relative" }}>
            <button className="close-overlay" onClick={() => navigate(-1)} aria-label="Close">×</button>
            <h2>Welcome to Pinewood Derby</h2>
            <p>To get started, please give this event a name.</p>
            <form onSubmit={handleNameSubmit} className="stack">
              <label>
                Event Name
                <input
                  value={nameTouched ? newName : (event?.name && event.name !== "New Pinewood Derby Event" ? event.name : "")}
                  onChange={(e) => {
                    setNameTouched(true);
                    setNewName(e.target.value);
                  }}
                  placeholder="e.g. Pack 123 Annual Race"
                  required
                  autoFocus
                />
              </label>
              <button type="submit">Start Setup</button>
            </form>
            {namingError ? <p className="error">{namingError}</p> : null}
          </section>
        </div>
      ) : event ? (
        <>
          <section className="kiosk-board">
            <h1>{event.name}</h1>
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

            {!event.setupComplete ? (
              <div className="kiosk-configuring">
                <div className="configuring-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 14.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.22-1.12.53-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L3.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L3.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.41 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.22 1.12-.53 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"
                    />
                  </svg>
                </div>
                <h2>Configuring Event</h2>
                <p>Please wait while the operator finishes setup.</p>
              </div>
            ) : event.isComplete && event.championScoutId ? (
              <div className="kiosk-final">
                <div className="kiosk-final-hero">
                  <div className="kiosk-final-title">Final Standings</div>
                  <div className="kiosk-final-winner">
                    Champion:{" "}
                    <span className="kiosk-final-winner-name">
                      #{scoutMap.get(event.championScoutId)?.carNumber} {scoutMap.get(event.championScoutId)?.name}
                    </span>
                  </div>
                  {event.popularVoteRevealAt ? (
                    (() => {
                      const revealAt = event.popularVoteRevealAt ?? 0;
                      const countdownSteps = event.popularVoteRevealCountdownSeconds ?? 3;
                      const stepMs = 1500;
                      const revealEndMs = revealAt + countdownSteps * stepMs;
                      const remainingSteps = Math.max(0, Math.ceil((revealEndMs - nowMs) / stepMs));

                      if (remainingSteps > 0) {
                        return (
                          <div className="kiosk-popular-countdown" aria-label="Popular vote countdown">
                            <div className="kiosk-popular-countdown-title">Popular Vote</div>
                            <div className="kiosk-popular-countdown-number">{remainingSteps}</div>
                          </div>
                        );
                      }

                      return (
                        <div className="kiosk-final-popular">
                          Popular Vote:{" "}
                          <span className="kiosk-final-winner-name">
                            {event.popularVoteWinner
                              ? `#${event.popularVoteWinner.carNumber} ${event.popularVoteWinner.name}`
                              : "No votes"}
                          </span>
                        </div>
                      );
                    })()
                  ) : null}
                </div>
                <div className="kiosk-final-standings">
                  {event.standings.map((scout, index) => (
                    <div
                      key={scout.id}
                      className={`kiosk-final-row ${index < 3 ? `rank-${index + 1}` : ""}`}
                    >
                      <span className="kiosk-final-rank">{index + 1}</span>
                      <span className="kiosk-final-name">#{scout.carNumber} {scout.name}{scout.groupName ? ` (${scout.groupName})` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="kiosk-grid">
                <div className="kiosk-card kiosk-heat-primary">
                  {showWinnerOverlay && previousWinner ? (
                    <div className="kiosk-heat-winner">
                      <div className="winner-label">Heat Winner</div>
                      <div className="winner-number-large">#{previousWinner.carNumber}</div>
                      <div className="winner-name-large">{previousWinner.name}</div>
                      {previousWinner.groupName ? <div className="winner-group">{previousWinner.groupName}</div> : null}
                      <div className="winner-sub">Readying next heat...</div>
                    </div>
                  ) : (
                    <>
                      <h2>Current Heat</h2>
                      {!currentHeat ? <p>Waiting for next heat...</p> : null}
                      <div className="heat-lanes">
                        {currentHeat?.laneAssignments.map((scoutId, laneIndex) => (
                          <div key={scoutId} className="heat-lane">
                            <span className="lane-number">Lane {laneIndex + 1}</span>
                            <div className="lane-scout">
                              <div className="lane-scout-number">#{scoutMap.get(scoutId)?.carNumber}</div>
                              <div className="lane-scout-name">{scoutMap.get(scoutId)?.name}</div>
                              {scoutMap.get(scoutId)?.groupName ? (
                                <div className="lane-scout-group">{scoutMap.get(scoutId)?.groupName}</div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <div className="kiosk-card kiosk-standings-card">
                  <h2>Current Standings</h2>
                  <div className="kiosk-standings-list">
                    {event.standings.map((scout, index) => (
                      <div key={scout.id} className={`kiosk-standing-item ${scout.eliminated ? "eliminated" : ""}`}>
                        <span className="standing-rank">#{index + 1}</span>
                        <span className="standing-name">#{scout.carNumber} {scout.name}{scout.groupName ? ` (${scout.groupName})` : ""}</span>
                        <span className="standing-status">
                          {scout.eliminated ? (scout.dropped ? "Dropped" : "Out") : `${scout.points} point${scout.points === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
          {showPairing ? (
            <div className="kiosk-pairing-overlay">
              <button className="close-overlay" onClick={() => setShowPairing(false)} aria-label="Close pairing">×</button>
              <h2>Pair Operator</h2>
              {qrSrc ? <img src={qrSrc} alt="Scan to control event" /> : <p>Generating QR...</p>}
              {pairingCode ? (
                <div className="pairing-code-display">
                  <code>{pairingCode}</code>
                </div>
              ) : null}
              {qrUrl ? <div className="overlay-note" style={{ wordBreak: "break-all" }}>{qrUrl}</div> : null}
              <p className="overlay-note">Scan QR and enter code to link device</p>
              <div className="overlay-actions">
                <a href={`/pair/${qrToken}?code=${pairingCode}`} target="_blank" rel="noopener noreferrer" className="direct-link">
                  Open operator view on this device
                </a>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {event?.id ? (
        <button
          className={`kiosk-share-btn ${shareStatus === "copied" ? "copied" : ""}`}
          onClick={() => void copyKioskLink()}
          disabled={shareStatus === "copying"}
          aria-label="Copy kiosk link"
        >
          {shareStatus === "copied" ? (
            "✓ Link copied"
          ) : shareStatus === "copying" ? (
            "…"
          ) : (
            <>
              <span className="kiosk-share-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M10.59 13.41a1 1 0 0 1 0-1.41l3.3-3.3a3 3 0 0 1 4.24 4.24l-2.83 2.83a3.5 3.5 0 0 1-4.95 0 1 1 0 1 1 1.41-1.41 1.5 1.5 0 0 0 2.12 0l2.83-2.83a1 1 0 1 0-1.41-1.41l-3.3 3.3a1 1 0 0 1-1.41 0Z"
                  />
                  <path
                    fill="currentColor"
                    d="M13.41 10.59a1 1 0 0 1 0 1.41l-3.3 3.3a3 3 0 0 1-4.24-4.24l2.83-2.83a3.5 3.5 0 0 1 4.95 0 1 1 0 0 1-1.41 1.41 1.5 1.5 0 0 0-2.12 0L7.29 11.5a1 1 0 1 0 1.41 1.41l3.3-3.3a1 1 0 0 1 1.41 0Z"
                  />
                </svg>
              </span>
              Link
            </>
          )}
        </button>
      ) : null}
    </main>
  );
}
