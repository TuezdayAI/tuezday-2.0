import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { workspaceInvites, workspaces } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { asUser, createTestDb, registerUser, type TestUser } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated post text.", model: "fake-model", provider: "fake", durationMs: 5 };
  },
};

describe("teams API", () => {
  let app: TuezdayApp;
  let db: Db;
  let owner: TestUser;
  let ownerApp: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp({ db, llm: fakeGateway, workerToken: "worker-secret" });
    owner = await registerUser(app, "owner@test.dev", "Olive Owner");
    ownerApp = asUser(app, owner.token);
    workspaceId = (
      await ownerApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Team Space" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function invite(email: string): Promise<{ id: string; token: string }> {
    const res = await ownerApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/invites`,
      payload: { email },
    });
    if (res.statusCode !== 201) throw new Error(`invite failed: ${res.body}`);
    return res.json();
  }

  async function joinAsMember(email: string, name: string): Promise<TestUser> {
    const user = await registerUser(app, email, name);
    const inv = await invite(email);
    const res = await asUser(app, user.token).inject({
      method: "POST",
      url: `/invites/${inv.token}/accept`,
    });
    if (res.statusCode !== 200) throw new Error(`accept failed: ${res.body}`);
    return user;
  }

  describe("membership scoping", () => {
    it("makes the creator the owner", async () => {
      const res = await ownerApp.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/members`,
      });
      expect(res.statusCode).toBe(200);
      const members = res.json();
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: owner.id, role: "owner", email: "owner@test.dev" });
    });

    it("lists only the workspaces the user belongs to", async () => {
      const stranger = await registerUser(app, "stranger@test.dev", "Stranger");
      const mine = (await ownerApp.inject({ method: "GET", url: "/workspaces" })).json();
      expect(mine.map((w: { id: string }) => w.id)).toEqual([workspaceId]);
      const theirs = (
        await asUser(app, stranger.token).inject({ method: "GET", url: "/workspaces" })
      ).json();
      expect(theirs).toEqual([]);
    });

    it("blocks non-members from workspace routes with 403", async () => {
      const stranger = await registerUser(app, "stranger@test.dev", "Stranger");
      const strangerApp = asUser(app, stranger.token);
      for (const url of [
        `/workspaces/${workspaceId}`,
        `/workspaces/${workspaceId}/brain`,
        `/workspaces/${workspaceId}/drafts`,
      ]) {
        const res = await strangerApp.inject({ method: "GET", url });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("not_a_member");
      }
    });

    it("lets a member through workspace routes", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const res = await asUser(app, member.token).inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain`,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("invites", () => {
    it("owner creates an invite bound to an email", async () => {
      const res = await ownerApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/invites`,
        payload: { email: "New@Test.dev" },
      });
      expect(res.statusCode).toBe(201);
      const inv = res.json();
      expect(inv.email).toBe("new@test.dev");
      expect(inv.status).toBe("pending");
      expect(typeof inv.token).toBe("string");
      expect(inv.expiresAt).toBeGreaterThan(Date.now());
    });

    it("members cannot manage invites (owner-only) — 403", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const memberApp = asUser(app, member.token);
      const create = await memberApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/invites`,
        payload: { email: "x@test.dev" },
      });
      expect(create.statusCode).toBe(403);
      expect(create.json().error).toBe("owner_only");
      const list = await memberApp.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/invites`,
      });
      expect(list.statusCode).toBe(403);
    });

    it("refuses inviting an existing member with 409", async () => {
      await joinAsMember("member@test.dev", "Mia Member");
      const res = await ownerApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/invites`,
        payload: { email: "member@test.dev" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("already_member");
    });

    it("refuses a duplicate pending invite with 409", async () => {
      await invite("new@test.dev");
      const res = await ownerApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/invites`,
        payload: { email: "new@test.dev" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("already_invited");
    });

    it("previews an invite by token", async () => {
      const inv = await invite("new@test.dev");
      const viewer = await registerUser(app, "new@test.dev", "Newbie");
      const res = await asUser(app, viewer.token).inject({
        method: "GET",
        url: `/invites/${inv.token}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        workspaceName: "Team Space",
        email: "new@test.dev",
        status: "pending",
      });
    });

    it("accepting joins the workspace as member", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const members = (
        await ownerApp.inject({ method: "GET", url: `/workspaces/${workspaceId}/members` })
      ).json();
      expect(members).toHaveLength(2);
      expect(members.find((m: { userId: string }) => m.userId === member.id)).toMatchObject({
        role: "member",
      });
      const theirWorkspaces = (
        await asUser(app, member.token).inject({ method: "GET", url: "/workspaces" })
      ).json();
      expect(theirWorkspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId]);
    });

    it("rejects accepting with a mismatched email — 403", async () => {
      const inv = await invite("invited@test.dev");
      const wrong = await registerUser(app, "other@test.dev", "Other");
      const res = await asUser(app, wrong.token).inject({
        method: "POST",
        url: `/invites/${inv.token}/accept`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("email_mismatch");
    });

    it("rejects an expired invite with 410", async () => {
      const inv = await invite("late@test.dev");
      db.update(workspaceInvites)
        .set({ expiresAt: Date.now() - 1000 })
        .where(eq(workspaceInvites.id, inv.id))
        .run();
      const late = await registerUser(app, "late@test.dev", "Late");
      const res = await asUser(app, late.token).inject({
        method: "POST",
        url: `/invites/${inv.token}/accept`,
      });
      expect(res.statusCode).toBe(410);
    });

    it("owner revokes a pending invite; accepting it then fails with 410", async () => {
      const inv = await invite("revoked@test.dev");
      const del = await ownerApp.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/invites/${inv.id}`,
      });
      expect(del.statusCode).toBe(204);
      const pending = (
        await ownerApp.inject({ method: "GET", url: `/workspaces/${workspaceId}/invites` })
      ).json();
      expect(pending).toHaveLength(0);
      const user = await registerUser(app, "revoked@test.dev", "Rev");
      const res = await asUser(app, user.token).inject({
        method: "POST",
        url: `/invites/${inv.token}/accept`,
      });
      expect(res.statusCode).toBe(410);
    });
  });

  describe("member removal", () => {
    it("owner removes a member, who then loses access", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const res = await ownerApp.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/members/${member.id}`,
      });
      expect(res.statusCode).toBe(204);
      const blocked = await asUser(app, member.token).inject({
        method: "GET",
        url: `/workspaces/${workspaceId}`,
      });
      expect(blocked.statusCode).toBe(403);
    });

    it("members cannot remove anyone — 403", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const res = await asUser(app, member.token).inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/members/${owner.id}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it("refuses removing the last owner with 409", async () => {
      const res = await ownerApp.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/members/${owner.id}`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("last_owner");
    });
  });

  describe("legacy workspaces", () => {
    it("lists memberless workspaces so they can be reached and claimed", async () => {
      const legacyId = randomUUID();
      const now = Date.now();
      db.insert(workspaces)
        .values({ id: legacyId, name: "Pre-auth Space", createdAt: now, updatedAt: now })
        .run();

      const list = (await ownerApp.inject({ method: "GET", url: "/workspaces" })).json();
      expect(list.map((w: { id: string }) => w.id)).toContain(legacyId);
    });

    it("first authenticated visitor claims a memberless workspace as owner", async () => {
      const legacyId = randomUUID();
      const now = Date.now();
      db.insert(workspaces)
        .values({ id: legacyId, name: "Pre-auth Space", createdAt: now, updatedAt: now })
        .run();

      const res = await ownerApp.inject({ method: "GET", url: `/workspaces/${legacyId}` });
      expect(res.statusCode).toBe(200);

      const members = (
        await ownerApp.inject({ method: "GET", url: `/workspaces/${legacyId}/members` })
      ).json();
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: owner.id, role: "owner" });

      // ...and it is closed to everyone else from then on.
      const stranger = await registerUser(app, "stranger@test.dev", "Stranger");
      const blocked = await asUser(app, stranger.token).inject({
        method: "GET",
        url: `/workspaces/${legacyId}`,
      });
      expect(blocked.statusCode).toBe(403);
    });
  });

  describe("worker service token", () => {
    it("authenticates as the system actor with access to all workspaces", async () => {
      const workerApp = asUser(app, "worker-secret");
      const all = await workerApp.inject({ method: "GET", url: "/workspaces" });
      expect(all.statusCode).toBe(200);
      expect(all.json().map((w: { id: string }) => w.id)).toContain(workspaceId);
      const brain = await workerApp.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain`,
      });
      expect(brain.statusCode).toBe(200);
    });
  });

  describe("actor attribution", () => {
    it("approval decisions record who acted", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      const memberApp = asUser(app, member.token);
      const generationId = (
        await ownerApp.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json().id;
      const draft = (
        await ownerApp.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
        })
      ).json();
      await memberApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });

      const detail = (
        await ownerApp.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/drafts/${draft.id}`,
        })
      ).json();
      const submit = detail.decisions.find((d: { action: string }) => d.action === "submit");
      const approve = detail.decisions.find((d: { action: string }) => d.action === "approve");
      expect(submit).toMatchObject({ actor: "Olive Owner", actorId: owner.id });
      expect(approve).toMatchObject({ actor: "Mia Member", actorId: member.id });
    });

    it("brain doc versions record who wrote them", async () => {
      const member = await joinAsMember("member@test.dev", "Mia Member");
      await ownerApp.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "v1 by owner" },
      });
      await asUser(app, member.token).inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "v2 by member" },
      });
      const versions = (
        await ownerApp.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/brain/soul/versions`,
        })
      ).json();
      const v1 = versions.find((v: { version: number }) => v.version === 1);
      const v2 = versions.find((v: { version: number }) => v.version === 2);
      expect(v1).toMatchObject({ actor: "Olive Owner", actorId: owner.id });
      expect(v2).toMatchObject({ actor: "Mia Member", actorId: member.id });
    });
  });
});
