/** Sign-ins: only confirmed email addresses (an emailed link, or Microsoft) are accounts here. */
import { describe, expect, it } from "vitest";
import { userFrom } from "../src/server/auth.js";

describe("which sign-ins are accounts", () => {
  const base = { uid: "u1", email: "akela@example.com" };

  it("an emailed link confirms the address", () => {
    expect(userFrom({ ...base, email_verified: true, firebase: { sign_in_provider: "password" } })).toEqual({ id: "u1", email: "akela@example.com" });
  });

  it("a password sign-in made through Firebase's API, unconfirmed, is no account", () => {
    expect(userFrom({ ...base, email_verified: false, firebase: { sign_in_provider: "password" } })).toBeNull();
    expect(userFrom(base)).toBeNull();
  });

  it("Microsoft's sign-ins are Microsoft's to vouch for", () => {
    expect(userFrom({ ...base, email_verified: false, firebase: { sign_in_provider: "microsoft.com" } })).toEqual({ id: "u1", email: "akela@example.com" });
  });

  it("a sign-in with no email address is no account", () => {
    expect(userFrom({ uid: "u1", email_verified: true })).toBeNull();
  });
});
