/*
  Signing in with a qStored account: with Microsoft, or by a link sent by email. Sign-in links and
  Microsoft both come back to this page, which finishes signing in.
*/
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AppHeader } from "../components/AppHeader";
import {
  completeEmailLink,
  emailLinkCode,
  finishMicrosoftSignIn,
  linkMicrosoftAfterEmail,
  microsoftAnswer,
  microsoftSignInOffered,
  pendingEmail,
  sendSignInLink,
  startMicrosoftSignIn,
} from "../shared/account";

type Stage = "choose" | "sent" | "confirm" | "working";

export function LoginPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(pendingEmail() ?? "");
  const [stage, setStage] = useState<Stage>("choose");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const code = useRef(emailLinkCode());
  const started = useRef(false);

  const finish = async () => {
    // Microsoft found an account made with an email link: link it now that the email link is in
    if ((await linkMicrosoftAfterEmail()) === "again") return;
    navigate("/events", { replace: true });
  };

  const signInWithLink = async (address: string) => {
    setStage("working");
    setError("");
    try {
      await completeEmailLink(address, code.current!);
      await finish();
    } catch (err) {
      code.current = null;
      setStage("choose");
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const answer = microsoftAnswer();
    if (answer) {
      setStage("working");
      finishMicrosoftSignIn(answer)
        .then(async (result) => {
          if (typeof result === "object") {
            setEmail(result.needsEmail);
            setStage("choose");
            setNotice("You already have an account with this email. Sign in by email link once, and Microsoft will be added to it.");
            return;
          }
          await finish();
        })
        .catch((err: Error) => {
          setStage("choose");
          setError(err.message);
        });
    } else if (code.current) {
      const address = pendingEmail();
      if (address) void signInWithLink(address);
      else setStage("confirm");
    } else if (user) {
      navigate("/events", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setStage("working");
    try {
      await sendSignInLink(email.trim());
      setStage("sent");
    } catch {
      setStage("choose");
      setError("The link couldn't be sent. Check the address and try again.");
    }
  };

  const microsoft = async () => {
    setError("");
    try {
      await startMicrosoftSignIn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="home-page">
      <AppHeader />
      <section className="card auth-card">
        <h1>Sign in</h1>
        {stage === "working" ? (
          <p className="muted" role="status">Signing in…</p>
        ) : stage === "sent" ? (
          <>
            <p>
              We've sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to finish signing in.
            </p>
            <button type="button" className="secondary-btn" onClick={() => setStage("choose")}>
              Use a different email
            </button>
          </>
        ) : stage === "confirm" ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void signInWithLink(email.trim());
            }}
          >
            <p className="muted">This link was opened on a different device or browser. Type the email it was sent to.</p>
            <label>
              Email <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <button type="submit">Sign in</button>
          </form>
        ) : (
          <>
            <p className="muted">
              {microsoftSignInOffered
                ? "Sign in with your Microsoft account, or get a link to sign in by email."
                : "We'll email you a link to sign in."}{" "}
              One qStored account keeps your events and Race Patrols on any device.
            </p>
            {notice ? <p role="status">{notice}</p> : null}
            {microsoftSignInOffered && !notice ? (
              <button type="button" className="microsoft-btn" onClick={() => void microsoft()}>
                <MicrosoftLogo />
                Sign in with Microsoft
              </button>
            ) : null}
            <form onSubmit={sendLink} className="stack">
              <label>
                Email <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <button type="submit">Email me a sign-in link</button>
            </form>
          </>
        )}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
