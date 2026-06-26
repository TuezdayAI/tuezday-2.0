import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleAuthError, exchangeCodeForProfile, googleAuthUrl } from "../src/auth/google";
import { registerAccount, sessionUser, upsertGoogleUser } from "../src/services/auth";
import { createTestDb } from "./helpers";
import { buildApp } from "../src/app";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/login/google/callback";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("googleAuthUrl", () => {
  it("builds a Google authorize URL with our params", () => {
    const url = new URL(googleAuthUrl("xyz-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/login/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("xyz-state");
  });
  it("throws when unconfigured", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => googleAuthUrl("s")).toThrow(GoogleAuthError);
  });
});

describe("exchangeCodeForProfile", () => {
  function fetcherFor(token: object, userinfo: object) {
    return (async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify(token), { status: 200 });
      if (url.includes("userinfo")) return new Response(JSON.stringify(userinfo), { status: 200 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  }

  it("returns the verified profile", async () => {
    const fetcher = fetcherFor(
      { access_token: "at" },
      { sub: "g-123", email: "Founder@Acme.com", email_verified: true, name: "Founder" },
    );
    const profile = await exchangeCodeForProfile(fetcher, "the-code");
    expect(profile).toEqual({ sub: "g-123", email: "founder@acme.com", emailVerified: true, name: "Founder" });
  });

  it("rejects an unverified email", async () => {
    const fetcher = fetcherFor({ access_token: "at" }, { sub: "g", email: "x@y.com", email_verified: false, name: "" });
    await expect(exchangeCodeForProfile(fetcher, "c")).rejects.toMatchObject({ code: "email_unverified" });
  });
});

describe("upsertGoogleUser", () => {
  const profile = { sub: "g-1", email: "founder@acme.com", emailVerified: true as const, name: "Founder" };

  it("creates a password-less user and a usable session for a new email", () => {
    const db = createTestDb();
    const { user, token } = upsertGoogleUser(db, profile);
    expect(user.email).toBe("founder@acme.com");
    expect(sessionUser(db, token)?.id).toBe(user.id); // session works
  });

  it("links to an existing email/password account (no duplicate)", () => {
    const db = createTestDb();
    const existing = registerAccount(db, { email: "founder@acme.com", password: "pw-12345", name: "Founder" });
    const { user } = upsertGoogleUser(db, profile);
    expect(user.id).toBe(existing.user.id); // same account
  });

  it("is idempotent across repeat Google logins", () => {
    const db = createTestDb();
    const first = upsertGoogleUser(db, profile);
    const second = upsertGoogleUser(db, profile);
    expect(second.user.id).toBe(first.user.id);
  });
});

function googleFetcher(userinfo: object): typeof fetch {
  return (async (url: string) => {
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    if (url.includes("userinfo")) return new Response(JSON.stringify(userinfo), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Google auth routes", () => {
  it("GET /auth/google/url returns an authorize URL (public, no token)", async () => {
    const app = await buildApp({ db: createTestDb() });
    const res = await app.inject({ method: "GET", url: "/auth/google/url?state=abc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("accounts.google.com");
  });

  it("503s when Google is unconfigured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const app = await buildApp({ db: createTestDb() });
    const res = await app.inject({ method: "GET", url: "/auth/google/url?state=abc" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("google_not_configured");
  });

  it("POST /auth/google/callback exchanges the code and returns a session", async () => {
    const app = await buildApp({
      db: createTestDb(),
      fetcher: googleFetcher({ sub: "g-9", email: "new@acme.com", email_verified: true, name: "New" }),
    });
    const res = await app.inject({ method: "POST", url: "/auth/google/callback", payload: { code: "c" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("new@acme.com");
    expect(typeof res.json().token).toBe("string");
  });

  it("401s an unverified Google email", async () => {
    const app = await buildApp({
      db: createTestDb(),
      fetcher: googleFetcher({ sub: "g", email: "x@y.com", email_verified: false, name: "" }),
    });
    const res = await app.inject({ method: "POST", url: "/auth/google/callback", payload: { code: "c" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("email_unverified");
  });
});
