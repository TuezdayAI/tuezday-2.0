import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_ACTION_KINDS, type ExternalActionKind } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignPlanRevisions,
  connections,
  externalActionPolicyRules,
  personas,
  workspaces,
} from "../src/db/schema";
import {
  ExternalActionPolicyInputError,
  ExternalActionPolicyScopeNotFoundError,
  deleteExternalActionPolicy,
  listExternalActionPolicies,
  resolveExternalActionPolicy,
  upsertExternalActionPolicies,
} from "../src/services/external-action-policy";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

describe("external action policy", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;

  function completeRules(
    overrides: Partial<Record<ExternalActionKind, "inherit" | "autonomous" | "human_required">> = {},
  ) {
    return EXTERNAL_ACTION_KINDS.map((actionKind) => ({
      actionKind,
      rule: overrides[actionKind] ?? "inherit",
    }));
  }

  function replacePolicy(
    scope: "workspace" | "campaign" | "persona" | "connection" | "lane",
    scopeId: string,
    overrides: Partial<Record<ExternalActionKind, "inherit" | "autonomous" | "human_required">>,
  ) {
    const current = listExternalActionPolicies(db, workspaceId, scope, scopeId);
    const defaults = scope === "workspace"
      ? Object.fromEntries(EXTERNAL_ACTION_KINDS.map((kind) => [kind, "human_required"]))
      : {};
    return upsertExternalActionPolicies(
      db,
      workspaceId,
      {
        scope,
        scopeId,
        expectedUpdatedAt: current.updatedAt,
        rules: completeRules({ ...defaults, ...overrides }),
      },
      null,
    );
  }

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Policy Lab" } })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", channels: ["linkedin"] },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("uses the safe workspace fallback and lets campaign policy replace it", () => {
    expect(
      resolveExternalActionPolicy(db, {
        workspaceId,
        actionKind: "publish",
        campaignId: null,
        personaId: null,
        connectionId: null,
        laneRevisionId: null,
      }),
    ).toMatchObject({
      effective: "human_required",
      contributingRules: [{ scope: "workspace", scopeId: workspaceId }],
    });

    replacePolicy("campaign", campaignId, { publish: "autonomous" });

    expect(
      resolveExternalActionPolicy(db, {
        workspaceId,
        actionKind: "publish",
        campaignId,
        personaId: null,
        connectionId: null,
        laneRevisionId: null,
      }).effective,
    ).toBe("autonomous");
  });

  it("lets persona, connection, and lane constraints tighten campaign autonomy", () => {
    const now = Date.now();
    const personaId = randomUUID();
    const connectionId = randomUUID();
    const planRevisionId = randomUUID();
    const laneId = randomUUID();
    const laneRevisionId = randomUUID();
    db.insert(personas)
      .values({ id: personaId, workspaceId, name: "Founder", createdAt: now, updatedAt: now })
      .run();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "linkedin",
        nangoConnectionId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(campaignPlanRevisions)
      .values({
        id: planRevisionId,
        workspaceId,
        campaignId,
        revision: 1,
        status: "active",
        createdAt: now,
      })
      .run();
    db.insert(campaignLanes)
      .values({
        id: laneId,
        workspaceId,
        campaignId,
        key: "founder-linkedin",
        name: "Founder LinkedIn",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(campaignLaneRevisions)
      .values({
        id: laneRevisionId,
        workspaceId,
        laneId,
        planRevisionId,
        personaId,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: connectionId,
        deliveryMode: "scheduled",
        createdAt: now,
      })
      .run();

    replacePolicy("campaign", campaignId, { publish: "autonomous" });
    replacePolicy("lane", laneRevisionId, { publish: "human_required" });

    const resolved = resolveExternalActionPolicy(db, {
      workspaceId,
      actionKind: "publish",
      campaignId,
      personaId,
      connectionId,
      laneRevisionId,
    });
    expect(resolved.effective).toBe("human_required");
    expect(resolved.contributingRules).toEqual([
      expect.objectContaining({ scope: "workspace", rule: "human_required" }),
      expect.objectContaining({ scope: "campaign", rule: "autonomous" }),
      expect.objectContaining({ scope: "persona", scopeLabel: "Founder", rule: "inherit" }),
      expect.objectContaining({ scope: "connection", rule: "inherit" }),
      expect.objectContaining({ scope: "lane", scopeLabel: "Founder LinkedIn", rule: "human_required" }),
    ]);
  });

  it("rejects cross-workspace scopes and policies that relax a safety constraint", () => {
    const now = Date.now();
    const otherWorkspaceId = randomUUID();
    const protectedPersonaId = randomUUID();
    db.insert(workspaces)
      .values({ id: otherWorkspaceId, name: "Other", createdAt: now, updatedAt: now })
      .run();
    db.insert(personas)
      .values({
        id: protectedPersonaId,
        workspaceId: otherWorkspaceId,
        name: "Protected",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(() =>
      upsertExternalActionPolicies(
        db,
        workspaceId,
        {
          scope: "persona",
          scopeId: protectedPersonaId,
          expectedUpdatedAt: null,
          rules: completeRules({ publish: "human_required" }),
        },
        null,
      ),
    ).toThrow(ExternalActionPolicyScopeNotFoundError);

    const localPersonaId = randomUUID();
    db.insert(personas)
      .values({ id: localPersonaId, workspaceId, name: "Sensitive", createdAt: now, updatedAt: now })
      .run();
    expect(() =>
      upsertExternalActionPolicies(
        db,
        workspaceId,
        {
          scope: "persona",
          scopeId: localPersonaId,
          expectedUpdatedAt: null,
          rules: completeRules({ publish: "autonomous" }),
        },
        null,
      ),
    ).toThrow(ExternalActionPolicyInputError);
  });

  it("serves bounded policy reads, upserts, and deletion through authenticated routes", async () => {
    const initial = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-action-policies?scope=workspace&scopeId=${workspaceId}`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().rules).toHaveLength(6);
    expect(initial.json().effective).toHaveLength(6);

    const updated = await putActionPolicy(app, workspaceId, "campaign", campaignId, {
      publish: "autonomous",
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const publish = updated.json().effective.find((item: { actionKind: string }) => item.actionKind === "publish");
    expect(publish.policy.effective).toBe("autonomous");

    const ruleId = updated.json().rules[0].id as string;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/external-action-policies/${ruleId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleteExternalActionPolicy(db, workspaceId, ruleId)).toBe(false);
  });

  it("atomically replaces a complete campaign scope and deletes inherited rows", async () => {
    const updated = await putActionPolicy(app, workspaceId, "campaign", campaignId, {
      publish: "autonomous",
    });

    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().rules).toHaveLength(1);
    expect(updated.json().rules[0]).toMatchObject({
      actionKind: "publish",
      rule: "autonomous",
    });
    expect(updated.json().updatedAt).toEqual(expect.any(Number));
  });

  it("rejects a stale complete scope write without changing current rules", async () => {
    const initial = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-action-policies?scope=campaign&scopeId=${campaignId}`,
    });
    const initialUpdatedAt = initial.json().updatedAt as number;
    const first = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: campaignId,
        expectedUpdatedAt: initialUpdatedAt,
        rules: completeRules({ publish: "autonomous" }),
      },
    });
    expect(first.statusCode, first.body).toBe(200);

    const stale = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: campaignId,
        expectedUpdatedAt: initialUpdatedAt,
        rules: completeRules({ publish: "human_required" }),
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "policy_conflict",
      current: {
        updatedAt: first.json().updatedAt,
        rules: [{ actionKind: "publish", rule: "autonomous" }],
      },
    });
    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-action-policies?scope=campaign&scopeId=${campaignId}`,
    });
    expect(after.json().rules).toEqual(first.json().rules);
  });

  it("returns 404 for inaccessible scopes and 400 for malformed batches", async () => {
    const missing = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: randomUUID(),
        expectedUpdatedAt: null,
        rules: completeRules({ publish: "autonomous" }),
      },
    });
    expect(missing.statusCode).toBe(404);

    const duplicateBatch = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: campaignId,
        expectedUpdatedAt: null,
        rules: completeRules({ publish: "autonomous" }).map((rule, index) =>
          index === EXTERNAL_ACTION_KINDS.length - 1
            ? { actionKind: "publish", rule: "human_required" }
            : rule,
        ),
      },
    });
    expect(duplicateBatch.statusCode).toBe(400);
  });

  it("backfills pre-existing workspaces once when the app starts", async () => {
    const coldDb = createTestDb();
    const now = Date.now();
    const coldWorkspaceId = randomUUID();
    coldDb.insert(workspaces)
      .values({ id: coldWorkspaceId, name: "Cold start", createdAt: now, updatedAt: now })
      .run();

    const coldApp = await buildAuthedApp({ db: coldDb });
    expect(
      coldDb
        .select()
        .from(externalActionPolicyRules)
        .all()
        .filter((row) => row.workspaceId === coldWorkspaceId),
    ).toHaveLength(6);
    await coldApp.close();
  });
});
