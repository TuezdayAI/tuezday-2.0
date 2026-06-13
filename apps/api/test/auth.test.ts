import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { sessions } from "../src/db/schema";
import { createTestDb, registerUser, TEST_PASSWORD } from "./helpers";

describe("auth API", () => {
  let app: TuezdayApp;
  let db: Db;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("register", () => {
    it("creates an account and returns a session token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "Ada@Example.com", password: TEST_PASSWORD, name: "Ada" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThanOrEqual(32);
      expect(userSchema.safeParse(body.user).success).toBe(true);
      expect(body.user.email).toBe("ada@example.com");
      expect(body.user).not.toHaveProperty("passwordHash");
    });

    it("rejects a duplicate email case-insensitively with 409", async () => {
      await registerUser(app, "ada@example.com");
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "ADA@example.com", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("email_taken");
    });

    it("rejects a short password with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "ada@example.com", password: "short" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid email with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "not-an-email", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("login", () => {
    it("returns a fresh token for valid credentials", async () => {
      const user = await registerUser(app, "ada@example.com", "Ada");
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "ada@example.com", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.id).toBe(user.id);
      expect(typeof body.token).toBe("string");
      expect(body.token).not.toBe(user.token);
    });

    it("rejects a wrong password with 401", async () => {
      await registerUser(app, "ada@example.com");
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "ada@example.com", password: "wrong-password-1" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_credentials");
    });

    it("rejects an unknown email with the same 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "nobody@example.com", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_credentials");
    });
  });

  describe("sessions", () => {
    it("GET /auth/me returns the user and their memberships", async () => {
      const user = await registerUser(app, "ada@example.com", "Ada");
      await app.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Adaspace" },
        headers: { authorization: `Bearer ${user.token}` },
      });
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.email).toBe("ada@example.com");
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0]).toMatchObject({ workspaceName: "Adaspace", role: "owner" });
    });

    it("logout revokes the session", async () => {
      const user = await registerUser(app);
      const out = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(out.statusCode).toBe(204);
      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(me.statusCode).toBe(401);
    });

    it("rejects an expired session with 401", async () => {
      const user = await registerUser(app);
      db.update(sessions).set({ expiresAt: Date.now() - 1000 }).where(eq(sessions.userId, user.id)).run();
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("route protection", () => {
    it("rejects protected routes without a token", async () => {
      const res = await app.inject({ method: "GET", url: "/workspaces" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthenticated");
    });

    it("rejects a garbage token with 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspaces",
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("keeps /health public", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });
  });
});
