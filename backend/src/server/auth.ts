/*
  Who is asking, and what they may do with an event.

  - Accounts are qStored accounts: the app sends the Firebase ID token as a Bearer token, and
    authenticate() puts the account on req.user.
  - An event can be opened by its owner, by anyone while it's an unclaimed guest event, or by a kiosk
    session bound to it (the x-kiosk-token header). A session made from a guest kiosk link can watch
    but not change an account's event.
*/
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Auth as FirebaseAuth } from "firebase-admin/auth";
import { collections, HttpError, type Db } from "./store/db.js";
import type { EventDoc, GuestLinkDoc, KioskSessionDoc } from "./store/types.js";

export type User = { id: string; email: string };

export interface AuthRequest extends Request {
  user?: User;
}

/** Checks a sign-in token. */
export interface Auth {
  verify(token: string): Promise<User | null>;
}

/** What's used of a sign-in's token. */
export interface SignInClaims {
  uid: string;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string };
}

/**
 * The account a sign-in is, or null. qStored signs people in by emailed link (which confirms the address) or with
 * Microsoft (whose addresses are Microsoft's to vouch for). Firebase also lets anyone make a password sign-in for
 * any address through its API, unconfirmed; those are no account here, so nobody can take an address that isn't
 * theirs. The same rule as the qStored API's (programmer-api, src/auth.ts).
 */
export function userFrom(claims: SignInClaims): User | null {
  if (!claims.email) return null;
  if (claims.email_verified !== true && claims.firebase?.sign_in_provider !== "microsoft.com") return null;
  return { id: claims.uid, email: claims.email };
}

export class FirebaseTokenAuth implements Auth {
  constructor(private readonly firebase: FirebaseAuth) {}

  async verify(token: string): Promise<User | null> {
    try {
      return userFrom(await this.firebase.verifyIdToken(token));
    } catch {
      return null;
    }
  }
}

export function authenticate(auth: Auth): RequestHandler {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const user = await auth.verify(header.slice(7));
      if (user) req.user = user;
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req: AuthRequest, res, next) => {
  if (!req.user) return void res.status(401).json({ message: "Authentication required" });
  next();
};

export function signedIn(req: AuthRequest): User {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return req.user;
}

type Access = { userId: string | null; kioskToken: string | null | undefined };

/** Whether this person (or kiosk) may see the event; with `write`, whether they may change it. */
export async function canAccessEvent(db: Db, who: Access, event: EventDoc, write: boolean): Promise<boolean> {
  if (event.isGuest && !event.userId) return true;
  if (who.userId && event.userId === who.userId) return true;
  if (!who.kioskToken) return false;

  const session = await db.get<KioskSessionDoc>(collections.kioskSessions, who.kioskToken);
  const now = Date.now();
  if (!session || now > session.expiresAt || session.eventId !== event.id) return false;
  if (write && session.guestKioskLinkId) return false;

  if (event.userId) {
    if (!session.accessExpiresAt || now > session.accessExpiresAt) return false;
    if (session.guestKioskLinkId) {
      const link = await db.get<GuestLinkDoc>(collections.guestLinks, session.guestKioskLinkId);
      if (!link || link.revokedAt || now > link.expiresAt) return false;
    }
  }
  return true;
}

/** Loads the event the request may see (or change), or throws 404/403. */
export async function eventFor(db: Db, req: AuthRequest, eventId: string, write: boolean): Promise<EventDoc> {
  const event = await db.get<EventDoc>(collections.events, eventId);
  if (!event) throw new HttpError(404, "Event not found");
  const allowed = await canAccessEvent(db, { userId: req.user?.id ?? null, kioskToken: req.header("x-kiosk-token") }, event, write);
  if (!allowed) throw new HttpError(403, "Authentication required to access this event");
  return event;
}
