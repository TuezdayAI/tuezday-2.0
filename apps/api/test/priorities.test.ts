import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  priorityQueueSchema,
  type ExternalAction,
  type ExternalActionKind,
  type ExternalActionStatus,
  type PriorityItem,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { connections, publications } from "../src/db/schema";
import { applyDraftAction, submitDraft } from "../src/services/drafts";
import { canonicalActionFingerprint } from "../src/services/external-action-fingerprint";
import {
  insertExternalAction,
  transitionExternalAction,
} from "../src/services/external-actions";
import { insertSignalMatch } from "../src/services/matching";
import { createSignal } from "../src/services/signals";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const T0 = new Date("2026-07-14T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;

describe("workspace priorities projection", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T0));
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeLlm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Priorities" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  interface SeedActionOptions {
    kind?: ExternalActionKind;
    status: ExternalActionStatus;
    title?: string;
    requestedFor?: number | null;
    campaignId?: string | null;
    campaignName?: string | null;
    blockerCode?: string;
    error?: string;
  }

  function seedAction(over: SeedActionOptions): ExternalAction {
    const id = randomUUID();
    let action = insertExternalAction(db, {
      id,
      workspaceId,
      kind: over.kind ?? "publish",
      subject: {
        kind: "draft",
        id: randomUUID(),
        title: over.title ?? "Launch post",
        summary: "Body.",
        channel: "linkedin",
        destination: "LinkedIn · feed",
      },
      context: {
        campaignId: over.campaignId ?? null,
        campaignName: over.campaignName ?? null,
        personaId: null,
        personaName: null,
        connectionId: null,
        connectionName: null,
        laneRevisionId: null,
        laneName: null,
      },
      payload: { seeded: true },
      requestedFor: over.requestedFor ?? null,
      idempotencyKey: `seed:${id}`,
      fingerprint: canonicalActionFingerprint({ id }),
      policy: { effective: "human_required", contributingRules: [] },
      actor: { userId: null, label: "system" },
      supersedesActionId: null,
      draftId: null,
    });
    const blocker = {
      code: over.blockerCode ?? "guardrail",
      message: over.error ?? "Blocked by a guardrail.",
      retryable: true,
    };
    if (over.status === "authorization_required") {
      action = transitionExternalAction(db, workspaceId, id, "authorization_required");
    } else if (over.status === "blocked") {
      action = transitionExternalAction(db, workspaceId, id, "blocked", { blocker });
    } else if (over.status === "stale") {
      action = transitionExternalAction(db, workspaceId, id, "stale", { blocker });
    } else if (over.status === "failed") {
      transitionExternalAction(db, workspaceId, id, "authorized");
      transitionExternalAction(db, workspaceId, id, "dispatching");
      action = transitionExternalAction(db, workspaceId, id, "failed", {
        execution: {
          kind: "publication",
          id: randomUUID(),
          status: "failed",
          url: null,
          error: over.error ?? "Provider refused.",
        },
      });
    } else if (over.status !== "proposed") {
      throw new Error(`unsupported seed status ${over.status}`);
    }
    return action;
  }

  function seedPendingDraft(): string {
    return submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId: null,
        personaId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "Pending body.",
      },
      { userId: null, label: "test" },
    ).id;
  }

  function seedFailedPublication(externalActionId: string | null): string {
    const connectionId = randomUUID();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: `nango-${connectionId}`,
        createdAt: T0 - HOUR,
        updatedAt: T0 - HOUR,
      })
      .run();
    const draft = submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId: null,
        personaId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "Published body.",
      },
      { userId: null, label: "test" },
    );
    applyDraftAction(db, draft, "approve", { userId: null, label: "test" });
    const id = randomUUID();
    db.insert(publications)
      .values({
        id,
        workspaceId,
        draftId: draft.id,
        externalActionId,
        connectionId,
        providerKey: "reddit",
        target: "r/startups",
        title: "Legacy failure",
        status: "failed",
        scheduledFor: T0 - 2 * HOUR,
        lastError: "RATELIMIT: slow down",
        createdAt: T0 - 3 * HOUR,
        updatedAt: T0 - 2 * HOUR,
      })
      .run();
    return id;
  }

  async function fetchPriorities(): Promise<PriorityItem[]> {
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/priorities` });
    expect(res.statusCode).toBe(200);
    return priorityQueueSchema.parse(res.json()).items;
  }

  /** Advance the frozen clock so creation-time tie-breaks are deterministic. */
  function tick(): void {
    vi.setSystemTime(new Date(Date.now() + 60_000));
  }

  it("ranks overdue failures, overdue authorizations, other blockers, authorizations, then reviews", async () => {
    const overdueFailed = seedAction({ status: "failed", requestedFor: T0 - HOUR, title: "Overdue failed" });
    tick();
    const overdueAuth = seedAction({
      status: "authorization_required",
      requestedFor: T0 - 30 * 60 * 1000,
      title: "Overdue authorization",
    });
    tick();
    const blocked = seedAction({ status: "blocked", title: "Blocked" });
    tick();
    const stale = seedAction({ status: "stale", title: "Stale" });
    tick();
    const auth = seedAction({ status: "authorization_required", title: "Fresh authorization" });
    tick();
    const draftId = seedPendingDraft();

    const items = await fetchPriorities();
    expect(items.map((item) => item.id)).toEqual([
      overdueFailed.id,
      overdueAuth.id,
      blocked.id,
      stale.id,
      auth.id,
      draftId,
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "execution_failure",
      "authorization",
      "policy_block",
      "stale_action",
      "authorization",
      "content_review",
    ]);
    expect(items.map((item) => item.status)).toEqual([
      "failed",
      "authorization_required",
      "policy_blocked",
      "stale",
      "authorization_required",
      "review_required",
    ]);
    // Deterministic: a second read returns the identical order.
    expect((await fetchPriorities()).map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it("breaks same-tier ties by due time, then creation time", async () => {
    const later = seedAction({
      status: "authorization_required",
      requestedFor: T0 + 2 * HOUR,
      title: "Due later",
    });
    const sooner = seedAction({
      status: "authorization_required",
      requestedFor: T0 + HOUR,
      title: "Due sooner",
    });
    const items = await fetchPriorities();
    expect(items.map((item) => item.id)).toEqual([sooner.id, later.id]);
  });

  it("dedupes a failed execution already represented by its governing action", async () => {
    const failedAction = seedAction({ status: "failed", title: "Failed publish" });
    seedFailedPublication(failedAction.id); // linked — the action item represents it
    const legacyPublicationId = seedFailedPublication(null); // legacy — its own item

    const items = await fetchPriorities();
    const failures = items.filter((item) => item.kind === "execution_failure");
    expect(failures).toHaveLength(2);
    expect(failures.map((item) => item.id).sort()).toEqual(
      [failedAction.id, legacyPublicationId].sort(),
    );
  });

  it("returns an all-clear queue when nothing needs attention", async () => {
    const items = await fetchPriorities();
    expect(items).toEqual([]);
  });

  it("carries campaign context, plain-language copy, and exact recovery URLs", async () => {
    const campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Summer push" },
      })
    ).json().id;
    const auth = seedAction({
      status: "authorization_required",
      campaignId,
      campaignName: "Summer push",
      title: "Queued post",
    });
    const draftId = seedPendingDraft();

    const items = await fetchPriorities();
    const authItem = items.find((item) => item.id === auth.id)!;
    expect(authItem.campaignName).toBe("Summer push");
    expect(authItem.href).toBe(
      `/workspaces/${workspaceId}/review?tab=authorizations&action=${auth.id}`,
    );
    expect(authItem.reason.length).toBeGreaterThan(0);
    expect(authItem.consequence.length).toBeGreaterThan(0);

    const reviewItem = items.find((item) => item.id === draftId)!;
    expect(reviewItem.href).toBe(`/workspaces/${workspaceId}/review?tab=approvals&draft=${draftId}`);
  });

  it("prioritizes active-campaign and overdue unmatched signals without duplicating drafted signals", async () => {
    const activeCampaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Active launch", status: "active" },
      })
    ).json().id;
    const pausedCampaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Paused launch", status: "paused" },
      })
    ).json().id;

    const matchedSignal = createSignal(db, workspaceId, {
      content: "A buyer is actively comparing launch platforms.",
      source: "other",
    });
    insertSignalMatch(db, workspaceId, matchedSignal.id, {
      personaId: null,
      campaignId: activeCampaignId,
      score: 92,
      reason: "Direct fit for the active launch.",
    });

    const draftedSignal = createSignal(db, workspaceId, {
      content: "A second buyer asked for a comparison.",
      source: "other",
    });
    insertSignalMatch(db, workspaceId, draftedSignal.id, {
      personaId: null,
      campaignId: activeCampaignId,
      score: 88,
      reason: "Also fits the active launch.",
    });
    submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        sourceSignalId: draftedSignal.id,
        campaignId: activeCampaignId,
        personaId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "Response draft.",
      },
      { userId: null, label: "test" },
    );

    vi.setSystemTime(new Date(T0 - 25 * HOUR));
    const overdueSignal = createSignal(db, workspaceId, {
      content: "An unmatched signal has waited for a campaign decision.",
      source: "other",
    });
    const pausedSignal = createSignal(db, workspaceId, {
      content: "This only belongs to a paused campaign.",
      source: "other",
    });
    insertSignalMatch(db, workspaceId, pausedSignal.id, {
      personaId: null,
      campaignId: pausedCampaignId,
      score: 99,
      reason: "The campaign is paused.",
    });
    vi.setSystemTime(new Date(T0));
    const freshUnmatchedSignal = createSignal(db, workspaceId, {
      content: "A fresh unmatched signal remains informational.",
      source: "other",
    });

    const items = await fetchPriorities();
    expect(items).toContainEqual(
      expect.objectContaining({
        id: matchedSignal.id,
        kind: "signal_triage",
        status: "review_required",
        href: `/workspaces/${workspaceId}/discovery?signal=${matchedSignal.id}`,
        campaignId: activeCampaignId,
        campaignName: "Active launch",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        id: overdueSignal.id,
        kind: "signal_triage",
        campaignId: null,
        dueAt: overdueSignal.createdAt + 24 * HOUR,
      }),
    );
    expect(items.some((item) => item.id === draftedSignal.id)).toBe(false);
    expect(items.some((item) => item.id === freshUnmatchedSignal.id)).toBe(false);
    expect(items.some((item) => item.id === pausedSignal.id)).toBe(true);
    expect(items.find((item) => item.id === pausedSignal.id)?.campaignId).toBeNull();
  });
});
