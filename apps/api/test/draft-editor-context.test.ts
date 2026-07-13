import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftEditorContextSchema } from "@tuezday/contracts";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignPlanRevisions,
  campaigns,
  connections,
  drafts,
  evidenceDocuments,
  generations,
  publications,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated", model: "fake-model", provider: "fake", durationMs: 5 };
  },
};

describe("draft editor context API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let draftId: string;
  let siblingId: string;
  let campaignOnlyId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeLlm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Editor" } })
    ).json().id;
    otherWorkspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
    ).json().id;

    const campaign = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: {
          name: "Launch",
          objective: "Book demos",
          channels: ["linkedin", "email"],
          automationMode: "human_in_the_loop",
        },
      })
    ).json();
    const planId = randomUUID();
    db.insert(campaignPlanRevisions)
      .values({
        id: planId,
        workspaceId,
        campaignId: campaign.id,
        revision: 1,
        status: "active",
        objective: "Book enterprise demos",
        kpi: "10 demos",
        timeframe: "Q3",
        startAt: null,
        endAt: null,
        audienceIdsJson: "[]",
        pillarsJson: "[]",
        offersJson: "[]",
        ctasJson: "[]",
        guidance: "Lead with the operating pain.",
        createdBy: null,
        createdAt: 180,
        activatedAt: 200,
      })
      .run();
    db.update(campaigns)
      .set({ currentPlanRevisionId: planId })
      .where(eq(campaigns.id, campaign.id))
      .run();

    const generationId = randomUUID();
    db.insert(generations)
      .values({
        id: generationId,
        workspaceId,
        taskType: "linkedin_post",
        channel: "linkedin",
        personaId: null,
        campaignId: campaign.id,
        leadId: null,
        mediaContactId: null,
        prompt: "Stored prompt",
        sectionsJson: JSON.stringify([
          {
            key: "campaign",
            layer: "campaign",
            title: "Campaign · Launch",
            content: "Book demos",
            included: true,
            reason: "Campaign selected",
            tokens: 2,
          },
          {
            key: "evidence",
            layer: "evidence",
            title: "Evidence",
            content: "[1] Customer proof",
            included: true,
            reason: "Retrieved one chunk",
            tokens: 3,
            evidence: {
              query: "enterprise demos",
              chunks: [
                {
                  text: "Customer proof",
                  title: "Proof note",
                  documentId: "r2r-proof",
                  kind: "manual",
                  score: 0.9,
                  recencyScore: 1,
                  sourceWeight: 1,
                  finalScore: 0.94,
                  kept: true,
                },
              ],
            },
          },
        ]),
        output: "Original output",
        model: "fake-model",
        provider: "fake",
        durationMs: 5,
        rating: null,
        ratedAt: null,
        reviewJson: null,
        createdAt: 100,
      })
      .run();

    const signalId = randomUUID();
    draftId = randomUUID();
    siblingId = randomUUID();
    campaignOnlyId = randomUUID();
    const baseDraft = {
      workspaceId,
      campaignId: campaign.id,
      leadId: null,
      mediaContactId: null,
      personaId: null,
      originalContent: "Original output",
      content: "Original output",
      state: "pending_review",
      reviewJson: null,
      mediaJson: null,
      createdAt: 110,
      updatedAt: 110,
    };
    db.insert(drafts)
      .values({
        ...baseDraft,
        id: draftId,
        sourceGenerationId: generationId,
        sourceSignalId: signalId,
        taskType: "linkedin_post",
        channel: "linkedin",
      })
      .run();
    db.insert(drafts)
      .values({
        ...baseDraft,
        id: siblingId,
        sourceGenerationId: null,
        sourceSignalId: signalId,
        taskType: "cold_email_opener",
        channel: "email",
      })
      .run();
    db.insert(drafts)
      .values({
        ...baseDraft,
        id: campaignOnlyId,
        sourceGenerationId: null,
        sourceSignalId: randomUUID(),
        taskType: "instagram_caption",
        channel: "instagram",
      })
      .run();

    db.insert(evidenceDocuments)
      .values({
        id: randomUUID(),
        workspaceId,
        r2rDocumentId: "r2r-proof",
        title: "Proof note",
        chars: 14,
        status: "ready",
        error: null,
        kind: "manual",
        sourceRef: "https://example.com/proof",
        sourceCreatedAt: 90,
        createdAt: 90,
      })
      .run();

    const connectionId = randomUUID();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "linkedin",
        nangoConnectionId: "nango-linkedin",
        configJson: "{}",
        displayName: "Founder LinkedIn",
        externalAccountId: "member-1",
        externalAccountName: "Founder",
        externalAccountHandle: "founder",
        externalAccountUrl: "https://linkedin.com/in/founder",
        status: "connected",
        lastCheckedAt: 100,
        lastError: null,
        contentProfileJson: "{}",
        createdAt: 80,
        updatedAt: 80,
      })
      .run();
    db.insert(publications)
      .values({
        id: randomUUID(),
        workspaceId,
        draftId,
        connectionId,
        providerKey: "linkedin",
        target: "feed",
        title: "Launch",
        mediaJson: null,
        cadenceId: null,
        status: "published",
        scheduledFor: 300,
        publishedAt: 310,
        externalId: "post-1",
        externalUrl: "https://linkedin.com/feed/update/1",
        lastError: null,
        createdAt: 300,
        updatedAt: 310,
      })
      .run();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a schema-conforming projection with provenance and recovery context", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/editor`,
    });
    expect(response.statusCode).toBe(200);
    const context = draftEditorContextSchema.parse(response.json());
    expect(context.draft.id).toBe(draftId);
    expect(context.contextSections.map((section) => section.key)).toEqual([
      "campaign",
      "evidence",
    ]);
    expect(context.evidenceCitations[0]).toMatchObject({
      documentId: "r2r-proof",
      title: "Proof note",
      url: "https://example.com/proof",
      kept: true,
    });
    expect(context.campaign).toMatchObject({
      name: "Launch",
      automationMode: "human_in_the_loop",
    });
    expect(context.staleness.stale).toBe(true);
    expect(context.siblings).toEqual([
      expect.objectContaining({ draftId: siblingId, channel: "email" }),
    ]);
    expect(context.siblings).not.toContainEqual(
      expect.objectContaining({ draftId: campaignOnlyId }),
    );
    expect(context.destination).toMatchObject({
      providerKey: "linkedin",
      label: "Founder LinkedIn",
      status: "connected",
    });
    expect(context.publications).toHaveLength(1);
    expect(context.executions).toEqual([
      expect.objectContaining({ kind: "publication", draftId, status: "completed" }),
    ]);
  });

  it("returns 404 when the draft is outside the requested workspace", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWorkspaceId}/drafts/${draftId}/editor`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("draft_not_found");
  });
});
