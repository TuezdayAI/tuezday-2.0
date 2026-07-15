import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { executionResultSchema, type ExecutionResult } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  adAccounts,
  adLaunches,
  connections,
  externalActions,
  launchMessages,
  launches,
  publications,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { applyDraftAction, submitDraft } from "../src/services/drafts";
import { canonicalActionFingerprint } from "../src/services/external-action-fingerprint";
import { insertExternalAction } from "../src/services/external-actions";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

// Fixed timestamps so ordering assertions are deterministic.
const T0 = new Date("2026-07-01T09:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;

// The write paths that produce these rows (publish attempts, launch dispatch,
// ad launch) are covered in publish.test.ts / launches.test.ts /
// ads-execution.test.ts — this file asserts only the unified projection, so
// fixtures are seeded directly.
describe("unified execution results", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let connectionId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeLlm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Executor" } })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Summer Launch" },
      })
    ).json().id;
    connectionId = randomUUID();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "reddit",
        nangoConnectionId: `nango-${connectionId}`,
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
  });

  afterEach(async () => {
    await app.close();
  });

  function approvedDraft(opts: { campaignId?: string | null } = {}): string {
    const draft = submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId: opts.campaignId ?? null,
        personaId: null,
        taskType: "linkedin_post",
        channel: "linkedin" as never,
        content: "Headline\nBody.",
      },
      { userId: null, label: "test" },
    );
    return applyDraftAction(db, draft, "approve", { userId: null, label: "test" }).id;
  }

  /** A minimal governing action row so operational FKs can link to it. */
  function seedActionRow(kind: "publish" | "send" | "paid_launch" = "publish"): string {
    const id = randomUUID();
    insertExternalAction(db, {
      id,
      workspaceId,
      kind,
      subject: {
        kind: "draft",
        id: randomUUID(),
        title: "Seeded",
        summary: "Body.",
        channel: "linkedin",
        destination: "LinkedIn · feed",
      },
      context: {
        campaignId: null,
        campaignName: null,
        personaId: null,
        personaName: null,
        connectionId: null,
        connectionName: null,
        laneRevisionId: null,
        laneName: null,
      },
      payload: {},
      requestedFor: null,
      idempotencyKey: `seed:${id}`,
      fingerprint: canonicalActionFingerprint({ id }),
      policy: { effective: "human_required", contributingRules: [] },
      actor: { userId: null, label: "system" },
      supersedesActionId: null,
      draftId: null,
    });
    return id;
  }

  function seedMutationAction(over: {
    kind: "budget_change" | "targeting_change";
    status: "succeeded" | "failed" | "stale";
    at: number;
    error?: string | null;
    withReceipt?: boolean;
  }): string {
    const launchId = randomUUID();
    const id = randomUUID();
    insertExternalAction(db, {
      id,
      workspaceId,
      kind: over.kind,
      subject: {
        kind: "ad_launch",
        id: launchId,
        title: over.kind === "budget_change" ? "Change budget · Launch" : "Change targeting · Launch",
        summary: "Exact Meta mutation",
        channel: "ads",
        destination: "Main account · set_1",
      },
      context: {
        campaignId,
        campaignName: "Summer Launch",
        personaId: null,
        personaName: null,
        connectionId: null,
        connectionName: "Main account",
        laneRevisionId: null,
        laneName: null,
      },
      payload: {},
      requestedFor: null,
      idempotencyKey: `mutation:${id}`,
      fingerprint: canonicalActionFingerprint({ id }),
      policy: { effective: "human_required", contributingRules: [] },
      actor: { userId: null, label: "test" },
      supersedesActionId: null,
      draftId: null,
    });
    db.update(externalActions)
      .set({
        status: over.status,
        executionKind: over.withReceipt === false ? null : "ad_mutation",
        executionId: over.withReceipt === false ? null : launchId,
        executionReceiptJson:
          over.withReceipt === false
            ? null
            : JSON.stringify({
                kind: "ad_mutation",
                id: launchId,
                status: over.status === "succeeded" ? `${over.kind === "budget_change" ? "budget" : "targeting"}_updated` : "failed",
                url: null,
                error: over.error ?? null,
              }),
        completedAt: over.at,
        updatedAt: over.at,
      })
      .where(eq(externalActions.id, id))
      .run();
    return id;
  }

  function seedPublication(over: {
    id?: string;
    draftId: string;
    status: "scheduled" | "published" | "failed";
    at: number;
    lastError?: string | null;
    externalUrl?: string | null;
    externalActionId?: string | null;
  }): string {
    const id = over.id ?? randomUUID();
    db.insert(publications)
      .values({
        id,
        workspaceId,
        draftId: over.draftId,
        externalActionId: over.externalActionId ?? null,
        connectionId,
        providerKey: "reddit",
        target: "r/startups",
        title: "Launch week teaser",
        status: over.status,
        scheduledFor: over.at,
        publishedAt: over.status === "published" ? over.at : null,
        externalUrl: over.externalUrl ?? null,
        lastError: over.lastError ?? null,
        createdAt: over.at - HOUR,
        updatedAt: over.at,
      })
      .run();
    return id;
  }

  function seedLaunch(over: {
    name: string;
    campaignId?: string | null;
    at: number;
    messages: Array<{
      status: "pending" | "sent" | "failed" | "skipped";
      lastError?: string;
      externalActionId?: string;
    }>;
  }): string {
    const id = randomUUID();
    db.insert(launches)
      .values({
        id,
        workspaceId,
        name: over.name,
        campaignId: over.campaignId ?? null,
        channelsJson: JSON.stringify(["email", "x"]),
        status: "completed",
        createdAt: over.at - HOUR,
        updatedAt: over.at,
      })
      .run();
    for (const [index, message] of over.messages.entries()) {
      db.insert(launchMessages)
        .values({
          id: randomUUID(),
          workspaceId,
          launchId: id,
          channel: "email",
          kind: "personalized",
          recipientName: `Recipient ${index}`,
          recipientEmail: `r${index}@example.com`,
          externalActionId: message.externalActionId ?? null,
          status: message.status,
          sentAt: message.status === "sent" ? over.at : null,
          lastError: message.lastError ?? null,
          createdAt: over.at - HOUR,
          updatedAt: over.at,
        })
        .run();
    }
    return id;
  }

  function seedAdLaunch(over: {
    name: string;
    at: number;
    status: "draft" | "approved" | "launched";
    platformStatus?: string | null;
    lastError?: string | null;
    externalActionId?: string | null;
  }): string {
    const adAccountId = randomUUID();
    db.insert(adAccounts)
      .values({
        id: adAccountId,
        workspaceId,
        externalId: `act_${adAccountId}`,
        name: "Main account",
        createdAt: T0,
      })
      .run();
    const id = randomUUID();
    db.insert(adLaunches)
      .values({
        id,
        workspaceId,
        adAccountId,
        campaignId,
        creativeDraftId: approvedDraft({ campaignId }),
        name: over.name,
        objective: "OUTCOME_TRAFFIC",
        pageId: "123",
        linkUrl: "https://tuezday.com",
        dailyBudgetCents: 500,
        countriesJson: JSON.stringify(["US"]),
        ageMin: 18,
        ageMax: 65,
        status: over.status,
        platformStatus: over.platformStatus ?? null,
        launchedAt: over.status === "launched" ? over.at : null,
        lastError: over.lastError ?? null,
        externalActionId: over.externalActionId ?? null,
        createdAt: over.at - HOUR,
        updatedAt: over.at,
      })
      .run();
    return id;
  }

  async function fetchResults(query = ""): Promise<ExecutionResult[]> {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/executions${query}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExecutionResult[];
    for (const entry of body) executionResultSchema.parse(entry);
    return body;
  }

  it("projects published and failed publications, excluding scheduled receipts", async () => {
    const campaignDraft = approvedDraft({ campaignId });
    seedPublication({
      draftId: campaignDraft,
      status: "published",
      at: T0 + 2 * HOUR,
      externalUrl: "https://reddit.com/r/startups/c/p1",
    });
    seedPublication({
      draftId: approvedDraft(),
      status: "failed",
      at: T0 + 3 * HOUR,
      lastError: "RATELIMIT: slow down",
    });
    seedPublication({ draftId: approvedDraft(), status: "scheduled", at: T0 + 9 * HOUR });

    const results = await fetchResults();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["failed", "completed"]);
    const failed = results[0];
    expect(failed?.kind).toBe("publication");
    expect(failed?.error).toBe("RATELIMIT: slow down");
    expect(failed?.campaignId).toBeNull();
    const completed = results[1];
    expect(completed?.url).toBe("https://reddit.com/r/startups/c/p1");
    expect(completed?.campaignId).toBe(campaignId);
    expect(completed?.campaignName).toBe("Summer Launch");
    expect(completed?.destinations).toEqual({
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
    });
  });

  it("rolls launch messages up into running, partial, failed, and completed results", async () => {
    seedLaunch({
      name: "All sent",
      at: T0 + 1 * HOUR,
      messages: [{ status: "sent" }, { status: "sent" }, { status: "skipped" }],
    });
    seedLaunch({
      name: "Partial",
      campaignId,
      at: T0 + 2 * HOUR,
      messages: [{ status: "sent" }, { status: "failed", lastError: "bounced" }],
    });
    seedLaunch({
      name: "All failed",
      at: T0 + 3 * HOUR,
      messages: [{ status: "failed", lastError: "no route" }],
    });
    seedLaunch({
      name: "In flight",
      at: T0 + 4 * HOUR,
      messages: [{ status: "sent" }, { status: "pending" }],
    });
    seedLaunch({
      name: "Not dispatched",
      at: T0 + 5 * HOUR,
      messages: [{ status: "pending" }, { status: "pending" }],
    });

    const results = await fetchResults();
    expect(results.map((r) => [r.title, r.status])).toEqual([
      ["In flight", "running"],
      ["All failed", "failed"],
      ["Partial", "partially_failed"],
      ["All sent", "completed"],
    ]);
    const partial = results.find((r) => r.title === "Partial");
    expect(partial?.kind).toBe("launch");
    expect(partial?.campaignName).toBe("Summer Launch");
    expect(partial?.destinations).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      pending: 0,
    });
    expect(partial?.error).toBe("bounced");
  });

  it("projects launched and failed ad launches, excluding gate states", async () => {
    seedAdLaunch({
      name: "Traffic push",
      at: T0 + 1 * HOUR,
      status: "launched",
      platformStatus: "ACTIVE",
    });
    seedAdLaunch({
      name: "Blocked spend",
      at: T0 + 2 * HOUR,
      status: "approved",
      lastError: "(#100) Invalid page id",
    });
    seedAdLaunch({ name: "Still drafting", at: T0 + 3 * HOUR, status: "draft" });

    const results = await fetchResults();
    expect(results.map((r) => [r.title, r.status])).toEqual([
      ["Blocked spend", "failed"],
      ["Traffic push", "completed"],
    ]);
    expect(results[1]?.kind).toBe("ad_launch");
    expect(results[1]?.platformStatus).toBe("ACTIVE");
    expect(results[0]?.error).toBe("(#100) Invalid page id");
  });

  it("projects only terminal Meta mutation actions with provider receipts", async () => {
    const budgetAction = seedMutationAction({
      kind: "budget_change",
      status: "succeeded",
      at: T0 + HOUR,
    });
    const targetingAction = seedMutationAction({
      kind: "targeting_change",
      status: "failed",
      at: T0 + 2 * HOUR,
      error: "Meta rejected targeting",
    });
    seedMutationAction({
      kind: "budget_change",
      status: "stale",
      at: T0 + 3 * HOUR,
      withReceipt: false,
    });

    const results = await fetchResults();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      kind: "ad_mutation",
      actionKind: "targeting_change",
      status: "failed",
      error: "Meta rejected targeting",
      externalActionIds: [targetingAction],
    });
    expect(results[1]).toMatchObject({
      kind: "ad_mutation",
      actionKind: "budget_change",
      status: "completed",
      externalActionIds: [budgetAction],
    });
  });

  it("filters by campaign and honors the limit", async () => {
    seedPublication({ draftId: approvedDraft({ campaignId }), status: "published", at: T0 + HOUR });
    seedLaunch({ name: "Scoped", campaignId, at: T0 + 2 * HOUR, messages: [{ status: "sent" }] });
    seedLaunch({ name: "Unscoped", at: T0 + 3 * HOUR, messages: [{ status: "sent" }] });

    const scoped = await fetchResults(`?campaign=${campaignId}`);
    expect(scoped.map((r) => r.kind).sort()).toEqual(["launch", "publication"]);
    expect(scoped.every((r) => r.campaignId === campaignId)).toBe(true);

    const limited = await fetchResults("?limit=1");
    expect(limited).toHaveLength(1);
    expect(limited[0]?.title).toBe("Unscoped");
  });

  it("carries governing action ids on results and keeps legacy rows empty", async () => {
    const publishAction = seedActionRow("publish");
    seedPublication({
      draftId: approvedDraft(),
      status: "published",
      at: T0 + HOUR,
      externalActionId: publishAction,
    });
    seedPublication({ draftId: approvedDraft(), status: "published", at: T0 + 2 * HOUR });

    const sendA = seedActionRow("send");
    const sendB = seedActionRow("send");
    seedLaunch({
      name: "Governed launch",
      at: T0 + 3 * HOUR,
      messages: [
        { status: "sent", externalActionId: sendA },
        { status: "sent", externalActionId: sendA }, // duplicate link stays unique
        { status: "failed", externalActionId: sendB },
        { status: "skipped" }, // legacy message without a link
      ],
    });

    const paidAction = seedActionRow("paid_launch");
    seedAdLaunch({
      name: "Governed spend",
      at: T0 + 4 * HOUR,
      status: "launched",
      externalActionId: paidAction,
    });

    const results = await fetchResults();
    const governedPublication = results.find(
      (r) => r.kind === "publication" && r.at === T0 + HOUR,
    );
    expect(governedPublication?.externalActionIds).toEqual([publishAction]);
    const legacyPublication = results.find(
      (r) => r.kind === "publication" && r.at === T0 + 2 * HOUR,
    );
    expect(legacyPublication?.externalActionIds).toEqual([]);

    const launch = results.find((r) => r.kind === "launch");
    expect(launch?.externalActionIds?.slice().sort()).toEqual([sendA, sendB].sort());

    const adLaunch = results.find((r) => r.kind === "ad_launch");
    expect(adLaunch?.externalActionIds).toEqual([paidAction]);
  });

  it("keeps workspaces isolated", async () => {
    seedLaunch({ name: "Mine", at: T0 + HOUR, messages: [{ status: "sent" }] });
    const other = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
    ).json().id;
    const res = await app.inject({ method: "GET", url: `/workspaces/${other}/executions` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
