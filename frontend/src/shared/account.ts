/*
  qstored accounts: signing in by email link or with Microsoft, through Firebase Authentication's REST
  API (so no outside script is loaded), the same as qstored's other apps. The account is the same as the
  Program Builder's, signed in separately at this address.

  Settings (Vite environment variables, at build time):
  - VITE_FIREBASE_API_KEY: the qstored Firebase project's web API key
  - VITE_MICROSOFT_SIGN_IN: "true" to offer Sign in with Microsoft (once it's set up in Firebase)
  - VITE_AUTH_EMULATOR_HOST: the Auth emulator's host:port, for local runs
*/
const apiKey = (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) ?? "";
const emulatorHost = (import.meta.env.VITE_AUTH_EMULATOR_HOST as string | undefined) ?? "";
export const microsoftSignInOffered = import.meta.env.VITE_MICROSOFT_SIGN_IN === "true";

export type Session = { uid: string; email: string; idToken: string; refreshToken: string; expiresAt: number };

const SESSION_KEY = "qstored.pinewood.session";
const PENDING_KEY = "qstored.pinewood.pendingEmail"; // the address a link was sent to, from this browser
const IDP_KEY = "qstored.pinewood.idp"; // { sessionId, at, link }: a Microsoft sign-in under way
const LINK_KEY = "qstored.pinewood.linkMicrosoft"; // { email, pendingToken, at }: Microsoft to link after an email link

const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* this visit only */
    }
  },
};

let session = store.get<Session>(SESSION_KEY);
let refreshing: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called whenever someone signs in or out. Gives a function to stop. */
export function onSessionChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const currentSession = () => session;

function setSession(next: Session | null) {
  const changed = (next?.uid ?? null) !== (session?.uid ?? null);
  session = next;
  store.set(SESSION_KEY, next);
  if (changed) listeners.forEach((l) => l());
}

// Signed in or out in another tab
window.addEventListener("storage", (e) => {
  if (e.key !== SESSION_KEY) return;
  const next = store.get<Session>(SESSION_KEY);
  const changed = (next?.uid ?? null) !== (session?.uid ?? null);
  session = next;
  if (changed) listeners.forEach((l) => l());
});

/** An error whose message can be shown as is. */
export class ShownError extends Error {
  readonly code: string;
  constructor(message: string, code = "") {
    super(message);
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Firebase's answers, read field by field
async function firebaseCall<T = any>(service: string, path: string, body: Record<string, unknown>, form = false): Promise<T> {
  const base = emulatorHost ? `http://${emulatorHost}/${service}` : `https://${service}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
  } catch {
    throw new ShownError("Can't reach the sign-in service. Check your connection.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShownError("Sign-in failed.", String(json.error?.message ?? ""));
  return json as T;
}

type SignInAnswer = { localId: string; email?: string; idToken: string; refreshToken: string; expiresIn?: string };

const sessionFrom = (r: SignInAnswer, email = ""): Session => ({
  uid: r.localId,
  email: r.email || email,
  idToken: r.idToken,
  refreshToken: r.refreshToken,
  expiresAt: Date.now() + (Number(r.expiresIn) || 3600) * 1000,
});

/** Where sign-in links and Microsoft come back to. */
const returnUrl = () => `${location.origin}/login`;

export async function sendSignInLink(email: string) {
  store.set(PENDING_KEY, email);
  await firebaseCall("identitytoolkit.googleapis.com", "/v1/accounts:sendOobCode", {
    requestType: "EMAIL_SIGNIN",
    email,
    continueUrl: returnUrl(),
    canHandleCodeInApp: true,
  });
}

/** The code from a sign-in link this page was opened with, if any. */
export function emailLinkCode(): string | null {
  const query = new URLSearchParams(location.search);
  return query.get("mode") === "signIn" ? query.get("oobCode") : null;
}

export const pendingEmail = () => store.get<string>(PENDING_KEY);

export async function completeEmailLink(email: string, oobCode: string) {
  let r: SignInAnswer;
  try {
    r = await firebaseCall("identitytoolkit.googleapis.com", "/v1/accounts:signInWithEmailLink", { email, oobCode });
  } catch (err) {
    const code = (err as ShownError).code;
    throw new ShownError(
      code.startsWith("INVALID_OOB_CODE") || code.startsWith("EXPIRED_OOB_CODE")
        ? "That sign-in link has been used or has run out. Send yourself a new one."
        : code.startsWith("INVALID_EMAIL")
          ? "That isn't the address the link was sent to."
          : "Signing in didn't work. Send yourself a new link.",
    );
  }
  store.set(PENDING_KEY, null);
  history.replaceState(null, "", location.pathname);
  setSession(sessionFrom(r, email));
}

export function signOut() {
  setSession(null);
}

/** A token the API will accept, renewed when it's about to run out. Null when not signed in. */
export async function idToken(force = false): Promise<string | null> {
  if (!session) return null;
  if (!force && session.expiresAt - Date.now() > 60_000) return session.idToken;
  refreshing ??= (async () => {
    try {
      const r = await firebaseCall(
        "securetoken.googleapis.com",
        "/v1/token",
        { grant_type: "refresh_token", refresh_token: session!.refreshToken },
        true,
      );
      setSession({ ...session!, idToken: r.id_token, refreshToken: r.refresh_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
    } catch (err) {
      // Signed out only when Firebase refused the renewal, not when it couldn't be reached
      if ((err as ShownError).code) setSession(null);
    } finally {
      refreshing = null;
    }
  })();
  await refreshing;
  return session?.idToken ?? null;
}

/* ---------------------------------------------------------------- Sign in with Microsoft */

/*
  Firebase does the OAuth with Microsoft (its client id and secret are set in the Firebase console):
  createAuthUri gives Microsoft's sign-in address, the person signs in there and comes back to /login, and
  signInWithIdp turns what Microsoft sent back into a Firebase sign-in, the same as an email link's.
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
const idp = <T = any>(path: string, body: Record<string, unknown>) =>
  firebaseCall<T>("identitytoolkit.googleapis.com", `/v1/accounts:${path}`, body);

/** Off to Microsoft to sign in. `link`: to link Microsoft to the account already signed in. */
export async function startMicrosoftSignIn(link = false) {
  let r: { authUri?: string; sessionId?: string } | null;
  try {
    r = await idp("createAuthUri", {
      providerId: "microsoft.com",
      continueUri: returnUrl(),
      customParameter: { prompt: "select_account" },
    });
  } catch {
    r = null;
  }
  if (!r?.authUri) throw new ShownError("Sign in with Microsoft isn't working just now. Use an email link instead.");
  store.set(IDP_KEY, { sessionId: r.sessionId, at: Date.now(), link });
  location.assign(r.authUri);
}

/** Microsoft's answer in this page's address, when a Microsoft sign-in is under way. */
export function microsoftAnswer(): { error: string | null } | null {
  if (!store.get(IDP_KEY)) return null;
  const query = new URLSearchParams(location.search);
  const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
  const get = (k: string) => query.get(k) ?? frag.get(k);
  return get("code") || get("id_token") || get("error") ? { error: get("error") } : null;
}

/**
  Back from Microsoft: finishes signing in (or linking). Answers "signed-in" or "linked", or { needsEmail }
  when the email already has an account (made with an email link), which is signed in that way once, so
  Microsoft can be linked to it. Throws a ShownError otherwise.
*/
export async function finishMicrosoftSignIn(answer: { error: string | null }): Promise<"signed-in" | "linked" | { needsEmail: string }> {
  const pending = store.get<{ sessionId?: string; link?: boolean }>(IDP_KEY) ?? {};
  const requestUri = location.href;
  store.set(IDP_KEY, null);
  history.replaceState(null, "", location.pathname);
  if (answer.error) {
    throw new ShownError(
      answer.error === "access_denied" ? "Microsoft sign-in was cancelled." : "Microsoft didn't sign you in. Try again, or use an email link.",
    );
  }
  const linking = Boolean(pending.link && session);
  let r: SignInAnswer & { needConfirmation?: boolean; pendingToken?: string };
  try {
    r = await idp("signInWithIdp", {
      requestUri,
      sessionId: pending.sessionId,
      returnSecureToken: true,
      returnIdpCredential: true,
      ...(linking ? { idToken: await idToken() } : {}),
    });
  } catch (err) {
    throw new ShownError(
      (err as ShownError).code.startsWith("FEDERATED_USER_ID_ALREADY_LINKED")
        ? "That Microsoft account is already used by another qstored account."
        : "Microsoft sign-in didn't finish. Try again, or use an email link.",
    );
  }
  if (linking) {
    if (r.idToken) setSession({ ...sessionFrom(r, session!.email), uid: session!.uid });
    return "linked";
  }
  if (r.needConfirmation || !r.idToken) {
    store.set(LINK_KEY, { email: r.email ?? "", pendingToken: r.pendingToken ?? null, at: Date.now() });
    return { needsEmail: r.email ?? "" };
  }
  if (!r.email) throw new ShownError("That Microsoft account has no email address, so it can't be used here. Use an email link instead.");
  setSession(sessionFrom(r));
  return "signed-in";
}

/**
  Signed in with an email link after Microsoft found the account: links Microsoft to it. Answers "linked",
  "again" (going round by Microsoft once more, to link it) or null (nothing to link).
*/
export async function linkMicrosoftAfterEmail(): Promise<"linked" | "again" | null> {
  const link = store.get<{ email: string; pendingToken: string | null; at: number }>(LINK_KEY);
  if (!link) return null;
  store.set(LINK_KEY, null);
  if (Date.now() - link.at > 24 * 3600e3 || !session || (link.email && link.email.toLowerCase() !== session.email.toLowerCase())) return null;
  if (link.pendingToken) {
    try {
      const r = await idp<SignInAnswer>("signInWithIdp", {
        idToken: await idToken(),
        pendingToken: link.pendingToken,
        requestUri: returnUrl(),
        returnSecureToken: true,
      });
      if (r.idToken) setSession({ ...sessionFrom(r, session.email), uid: session.uid });
      return "linked";
    } catch {
      /* the pending sign-in ran out: round by Microsoft again */
    }
  }
  await startMicrosoftSignIn(true);
  return "again";
}
