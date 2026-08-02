import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { externalActionSubmissionSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import {
  approvalDecisions,
  connections,
  drafts,
  externalActionDecisions,
  publications,
} from "../src/db/schema";
import {
  preparePublicationAction,
  publishActionAdapter,
} from "../src/services/external-action-adapters";
import { getExternalActionPayload } from "../src/services/external-actions";
import { resolveExternalActionPolicy } from "../src/services/external-action-policy";
import { fingerprintExternalActionIntent } from "../src/services/external-action-coordinator";
import { getDraft, submitAutomaticDraft } from "../src/services/drafts";
import { mintActionToken } from "../src/notifications/tokens";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

function publicationFabric(posts: Array<Record<string, string>>, fail: { value: boolean }): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "token" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: "{}" };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, options) {
      if (method === "POST" && path.startsWith("/api/submit")) {
        if (fail.value) {
          return {
            status: 200,
            json: { json: { errors: [["RATELIMIT", "slow down", "ratelimit"]], data: {} } },
          };
        }
        posts.push(options?.form ?? {});
        return {
          status: 200,
          json: {
            json: {
              errors: [],
              data: {
                name: `t3_post${posts.length}`,
                url: `https://reddit.com/r/test/post${posts.length}`,
              },
            },
          },
        };
      }
      return { status: 200, json: { name: "founder" } };
    },
  };
}

describe("external-action publication boundary", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let connectionId: string;
  let draftId: string;
  let posts: Array<Record<string, string>>;
  let fail: { value: boolean };

  beforeEach(async () => {
    db = createTestDb();
    posts = [];
    fail = { value: false };
    app = await buildAuthedApp({ db, connectors: publicationFabric(posts, fail) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Publisher" } })
    ).json().id;
    connectionId = randomUUID();
    draftId = randomUUID();
    const now = Date.now();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: randomUUID(),
        displayName: "Founder Reddit",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "Approved launch post",
        content: "Approved launch post",
        state: "approved",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  function publish(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/publish`,
      payload: {
        connectionId,
        target: "test",
        title: "Launch",
        idempotencyKey: "publish:test:one",
        ...overrides,
      },
    });
  }

  it("queues human-required publication and executes immediately after authorization", async () => {
    const queued = await publish();
    expect(queued.statusCode).toBe(202);
    const submission = externalActionSubmissionSchema.parse(queued.json());
    expect(submission.action.status).toBe("authorization_required");
    expect(posts).toHaveLength(0);
    expect(db.select().from(publications).all()).toEqual([]);

    const prepared = preparePublicationAction(
      db,
      workspaceId,
      draftId,
      {
        connectionId,
        target: "test",
        title: "Launch",
        idempotencyKey: "publish:test:one",
      },
      { idempotencyKey: "publish:test:one" },
    );
    const revalidated = await publishActionAdapter(
      db,
      publicationFabric(posts, fail),
      fetch,
    ).revalidate(submission.action, getExternalActionPayload(db, submission.action.id));
    expect(revalidated).toEqual({
      subject: prepared.subject,
      context: prepared.context,
      payload: prepared.payload,
      requestedFor: prepared.requestedFor,
      links: prepared.links,
    });
    const currentPolicy = resolveExternalActionPolicy(db, {
      workspaceId,
      actionKind: "publish",
      campaignId: null,
      personaId: null,
      connectionId,
      laneRevisionId: null,
    });
    expect(currentPolicy).toEqual(submission.action.policy);
    expect(revalidated).toEqual({
      subject: submission.action.subject,
      context: submission.action.context,
      payload: getExternalActionPayload(db, submission.action.id),
      requestedFor: submission.action.requestedFor,
      links: { draftId },
    });
    expect(
      fingerprintExternalActionIntent(workspaceId, "publish", revalidated, currentPolicy),
    ).toBe(submission.action.fingerprint);

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-actions?status=authorization_required`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().actions).toHaveLength(1);
    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-actions/${submission.action.id}`,
    });
    expect(detail.statusCode).toBe(200);

    const authorized = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${submission.action.id}/authorize`,
      payload: {},
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("succeeded");
    expect(posts).toHaveLength(1);
    expect(db.select().from(publications).all()[0]?.externalActionId).toBe(submission.action.id);

    const twice = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${submission.action.id}/authorize`,
      payload: {},
    });
    expect(twice.statusCode).toBe(409);
  });

  it("makes an identical HTTP retry return the same queued action", async () => {
    const first = await publish();
    const retry = await publish();
    expect(retry.statusCode).toBe(202);
    expect(retry.json().action.id).toBe(first.json().action.id);
    expect(posts).toHaveLength(0);
  });

  it("denies without creating a publication", async () => {
    const queued = await publish();
    const denied = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${queued.json().action.id}/deny`,
      payload: { reason: "Wrong account" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().action.status).toBe("cancelled");
    expect(db.select().from(publications).all()).toEqual([]);
  });

  it("dispatches autonomous policy exactly once with a linked receipt", async () => {
    const policy = await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      publish: "autonomous",
    });
    expect(policy.statusCode).toBe(200);

    const first = await publish();
    expect(first.statusCode).toBe(201);
    expect(first.json().action.status).toBe("succeeded");
    const retry = await publish();
    expect(retry.json().action.id).toBe(first.json().action.id);
    expect(posts).toHaveLength(1);
    expect(db.select().from(publications).all()).toHaveLength(1);
  });

  it("marks an edited queued draft stale and never calls the provider", async () => {
    const queued = await publish();
    db.update(drafts)
      .set({ content: "Edited after authorization request", updatedAt: Date.now() })
      .where(eq(drafts.id, draftId))
      .run();
    const authorized = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${queued.json().action.id}/authorize`,
      payload: {},
    });
    expect(authorized.statusCode).toBe(409);
    expect(authorized.json().action.status).toBe("stale");
    expect(posts).toHaveLength(0);
  });

  it("keeps a future authorized action receipt-free until the runner reaches its due time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-14T10:00:00Z"));
    const dueAt = Date.now() + 60_000;
    const queued = await publish({ scheduledFor: dueAt, idempotencyKey: "publish:scheduled" });
    const authorized = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${queued.json().action.id}/authorize`,
      payload: {},
    });
    expect(authorized.json().action.status).toBe("scheduled");
    expect(db.select().from(publications).all()).toEqual([]);

    vi.setSystemTime(dueAt + 1);
    const run = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/publish/run`,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().actions[0].action.status).toBe("succeeded");
    expect(posts).toHaveLength(1);
  });

  it("returns provider failure as a durable failed action and linked receipt", async () => {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      publish: "autonomous",
    });
    fail.value = true;
    const result = await publish();
    expect(result.statusCode).toBe(201);
    expect(result.json().action.status).toBe("failed");
    expect(result.json().execution.error).toContain("RATELIMIT");
    expect(db.select().from(publications).all()[0]).toMatchObject({
      status: "failed",
      externalActionId: result.json().action.id,
    });
  });

  // Sprint 52 — for `publish` only, a human's draft approval also authorizes
  // the publication, as long as the approved content still stands. The suite
  // above seeds `approved` drafts directly (no approval decision, so no
  // fingerprint), which is why it still exercises the two-gate path.
  describe("collapsed publish gate", () => {
    const IMAGE_A = JSON.stringify([{ url: "https://cdn.test/a.png", type: "image" }]);
    const IMAGE_B = JSON.stringify([{ url: "https://cdn.test/b.png", type: "image" }]);

    function seedPendingDraft(overrides: { content?: string; mediaJson?: string | null } = {}) {
      const id = randomUUID();
      const now = Date.now();
      db.insert(drafts)
        .values({
          id,
          workspaceId,
          taskType: "linkedin_post",
          channel: "linkedin",
          originalContent: "Reviewed launch post",
          content: overrides.content ?? "Reviewed launch post",
          mediaJson: overrides.mediaJson ?? null,
          state: "pending_review",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return id;
    }

    function approve(id: string) {
      return app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${id}/approve`,
      });
    }

    function publishDraft(id: string, overrides: Record<string, unknown> = {}) {
      return app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${id}/publish`,
        payload: {
          connectionId,
          target: "test",
          title: "Launch",
          idempotencyKey: `publish:collapse:${id}`,
          ...overrides,
        },
      });
    }

    function decisionsFor(actionId: string) {
      return db
        .select()
        .from(externalActionDecisions)
        .where(eq(externalActionDecisions.actionId, actionId))
        .all();
    }

    function approvalOf(draftId: string) {
      return db.select().from(approvalDecisions).where(eq(approvalDecisions.draftId, draftId)).get()!;
    }

    it("authorizes and publishes what a human already approved, attributed to that human", async () => {
      const id = seedPendingDraft();
      expect((await approve(id)).statusCode).toBe(200);

      const published = await publishDraft(id);
      expect(published.statusCode).toBe(201); // 201, not the 202 of a queued action
      const submission = externalActionSubmissionSchema.parse(published.json());
      // Authorized at propose time, so the same call dispatches it.
      expect(submission.action.status).toBe("succeeded");
      expect(submission.action.authorizedAt).not.toBeNull();
      expect(posts).toHaveLength(1);
      expect(db.select().from(publications).all()).toHaveLength(1);

      const approval = approvalOf(id);
      expect(approval.action).toBe("approve");
      expect(approval.actorId).not.toBeNull();
      const decisions = decisionsFor(submission.action.id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision: "authorize",
        // The human who approved the draft — never `system`, never the proposer.
        actorUserId: approval.actorId,
        actorLabel: approval.actor,
        subjectFingerprint: submission.action.fingerprint,
      });
      expect(decisions[0]?.reason).toMatch(/approv/i);

      // The queue a founder would look at is empty — nothing left to click.
      const queue = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/external-actions?status=authorization_required`,
      });
      expect(queue.json().actions).toEqual([]);
    });

    it("re-arms the second gate when the content changed after approval", async () => {
      const id = seedPendingDraft();
      await approve(id);
      // An `edit` also moves the draft out of `approved`, which publishing
      // refuses outright (409). The case that matters here is content that
      // drifted while the draft still reads as approved.
      db.update(drafts)
        .set({ content: "Rewritten after approval", updatedAt: Date.now() })
        .where(eq(drafts.id, id))
        .run();

      const published = await publishDraft(id);
      expect(published.statusCode).toBe(202);
      expect(published.json().action.status).toBe("authorization_required");
      expect(posts).toHaveLength(0);
      expect(decisionsFor(published.json().action.id)).toEqual([]);
    });

    it("re-arms the second gate when only the media changed after approval", async () => {
      const id = seedPendingDraft({ mediaJson: IMAGE_A });
      await approve(id);
      db.update(drafts)
        .set({ mediaJson: IMAGE_B, updatedAt: Date.now() })
        .where(eq(drafts.id, id))
        .run();
      expect(getDraft(db, workspaceId, id)?.content).toBe("Reviewed launch post");

      const published = await publishDraft(id);
      expect(published.statusCode).toBe(202);
      expect(published.json().action.status).toBe("authorization_required");
      expect(posts).toHaveLength(0);
    });

    it("never collapses for a system-approved draft (D2a)", async () => {
      const commit = submitAutomaticDraft(
        db,
        {
          workspaceId,
          sourceGenerationId: randomUUID(),
          taskType: "signal_response",
          channel: "linkedin",
          personaId: null,
          content: "Auto-drafted post text.",
          automationKey: `automation:v1:${workspaceId}:collapse`,
          autoApprove: true,
        },
        { userId: null, label: "system", human: false },
      );
      expect(commit.draft.state).toBe("approved");

      const published = await publishDraft(commit.draft.id);
      expect(published.statusCode).toBe(202);
      expect(published.json().action.status).toBe("authorization_required");
      expect(posts).toHaveLength(0);
      expect(decisionsFor(published.json().action.id)).toEqual([]);
    });

    it("collapses an approval made through the email one-click link (D2c)", async () => {
      const id = seedPendingDraft();
      const token = mintActionToken(db, workspaceId, id, "approve");
      const clicked = await app.inject({ method: "GET", url: `/a/${token}` });
      expect(clicked.statusCode).toBe(200);
      expect(getDraft(db, workspaceId, id)?.state).toBe("approved");

      const published = await publishDraft(id);
      expect(published.statusCode).toBe(201);
      expect(published.json().action.status).toBe("succeeded");
      expect(posts).toHaveLength(1);
      const decision = decisionsFor(published.json().action.id)[0]!;
      expect(decision.decision).toBe("authorize");
      // No user id behind a one-click link, but a named human all the same.
      expect(decision.actorUserId).toBeNull();
      expect(decision.actorLabel).toBe("Founder (via Mobile Notification)");
    });
  });
});
