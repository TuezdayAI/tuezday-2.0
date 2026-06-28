import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../db";
import {
  adCampaignMetrics,
  adCampaigns,
  brainDocuments,
  campaigns,
  drafts,
  engagementMetrics,
  generations,
  guidanceOverrides,
  inboxItems,
  launches,
  launchMessages,
  personas,
  publicationMetrics,
  publications,
  workspaces,
  adAccounts,
  connections,
} from "../db/schema";
import { createTestDb } from "../../test/helpers";
import { getCampaignInsights, getWorkspaceInsights } from "./insights";

function insertCampaign(db: Db, workspaceId: string, id: string, name: string) {
  db.insert(workspaces).values({ id: workspaceId, name: "W", createdAt: Date.now(), updatedAt: Date.now() }).onConflictDoNothing().run();
  db.insert(campaigns)
    .values({
      id,
      workspaceId,
      name,
      objective: "Obj",
      kpi: "KPI",
      timeframe: "Q3",
      audience: "Devs",
      pillarsJson: "[]",
      channelsJson: '["linkedin", "email"]',
      personaIdsJson: "[]",
      overlay: "",
      status: "active",
      automationMode: "manual",
      autoDailyCap: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

describe("insights.service", () => {
  it("getCampaignInsights handles an empty campaign safely", () => {
    const db = createTestDb();
    const wsId = randomUUID();
    const cId = randomUUID();
    insertCampaign(db, wsId, cId, "Empty");

    const campaign = { id: cId, workspaceId: wsId, name: "Empty", status: "active" } as any;
    const insights = getCampaignInsights(db, campaign);

    expect(insights.campaign.id).toBe(cId);
    expect(insights.paid).toBeNull();
    expect(insights.organic.publishedCount).toBe(0);
    expect(insights.organic.platform.likes).toBe(0);
    expect(insights.organic.learning.impressions).toBe(0);
    expect(insights.outbound.sentCount).toBe(0);
    expect(insights.outbound.replyRate).toBe(0);
    expect(insights.quality.approvalRate).toBe(0);
    expect(insights.byChannel).toEqual([]);
  });

  it("aggregates data correctly across all panes", () => {
    const db = createTestDb();
    const wsId = randomUUID();
    const cId = randomUUID();
    insertCampaign(db, wsId, cId, "Full");

    // Paid
    const adCId = randomUUID();
    const adAccId = randomUUID();

    db.insert(adAccounts).values({ id: adAccId, workspaceId: wsId, externalId: "e1", name: "Acc", currency: "USD", createdAt: Date.now() }).run();
    db.insert(adCampaigns)
      .values({
        id: adCId,
        workspaceId: wsId,
        adAccountId: adAccId,
        externalId: "ext1",
        name: "Ad C",
        campaignId: cId,
        lastSyncedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    db.insert(adCampaignMetrics)
      .values({
        id: randomUUID(),
        workspaceId: wsId,
        adCampaignId: adCId,
        date: "2026-06-01",
        spendCents: 1500,
        impressions: 1000,
        clicks: 50,
        conversions: 5,
        source: "sync",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    // Quality: drafts and generations
    const d1 = randomUUID();
    const d2 = randomUUID();
    db.insert(drafts)
      .values([
        { id: d1, workspaceId: wsId, campaignId: cId, state: "approved", taskType: "linkedin_post", channel: "linkedin", createdAt: Date.now(), updatedAt: Date.now(), content: "1", originalContent: "1" },
        { id: d2, workspaceId: wsId, campaignId: cId, state: "rejected", taskType: "linkedin_post", channel: "linkedin", createdAt: Date.now(), updatedAt: Date.now(), content: "2", originalContent: "2" },
      ])
      .run();
    db.insert(generations)
      .values({
        id: randomUUID(),
        workspaceId: wsId,
        campaignId: cId,
        rating: "accepted",
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: "prompt",
        output: "output",
        model: "model",
        provider: "provider",
        durationMs: 100,
        sectionsJson: "[]",
        createdAt: Date.now(),
      })
      .run();

    // Organic
    const p1 = randomUUID();
    const connId = randomUUID();
    db.insert(connections).values({ id: connId, workspaceId: wsId, providerKey: "linkedin", status: "active", nangoConnectionId: "nango1", configJson: "{}", createdAt: Date.now(), updatedAt: Date.now() }).run();

    db.insert(publications)
      .values({
        id: p1,
        workspaceId: wsId,
        draftId: d1,
        connectionId: connId,
        providerKey: "linkedin",
        target: "profile",
        title: "P1",
        status: "published",
        scheduledFor: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    db.insert(publicationMetrics)
      .values({
        id: randomUUID(),
        workspaceId: wsId,
        publicationId: p1,
        window: "7d",
        likes: 10,
        impressions: 500,
        capturedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    db.insert(engagementMetrics)
      .values({
        id: randomUUID(),
        workspaceId: wsId,
        draftId: d1,
        channel: "linkedin",
        engagements: 2,
        recordedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();

    // Outbound
    const l1 = randomUUID();
    db.insert(launches)
      .values({
        id: l1,
        workspaceId: wsId,
        campaignId: cId,
        name: "L1",
        channelsJson: "[]",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const m1 = randomUUID();
    db.insert(launchMessages)
      .values({
        id: m1,
        workspaceId: wsId,
        launchId: l1,
        channel: "email",
        kind: "broadcast",
        status: "sent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const inboxConnId = randomUUID();
    db.insert(connections).values({ id: inboxConnId, workspaceId: wsId, providerKey: "google", status: "active", nangoConnectionId: "nango2", configJson: "{}", createdAt: Date.now(), updatedAt: Date.now() }).run();

    db.insert(inboxItems)
      .values({
        id: randomUUID(),
        workspaceId: wsId,
        connectionId: inboxConnId,
        providerKey: "google",
        kind: "dm",
        channel: "email",
        externalId: "ext2",
        launchMessageId: m1,
        content: "reply",
        externalCreatedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const campaign = { id: cId, workspaceId: wsId, name: "Full", status: "active" } as any;
    const insights = getCampaignInsights(db, campaign);

    expect(insights.paid?.totals.spendCents).toBe(1500);
    expect(insights.quality.approvalRate).toBe(0.5); // 1 approved, 1 rejected
    expect(insights.quality.ratings.accepted).toBe(1);
    expect(insights.organic.publishedCount).toBe(1);
    expect(insights.organic.platform.likes).toBe(10);
    expect(insights.organic.learning.engagements).toBe(2);
    expect(insights.outbound.sentCount).toBe(1);
    expect(insights.outbound.repliedCount).toBe(1);
    expect(insights.outbound.replyRate).toBe(1); // 1 sent, 1 replied

    const byChannel = insights.byChannel;
    expect(byChannel).toContainEqual(
      expect.objectContaining({ channel: "ads", spendCents: 1500 }),
    );
    expect(byChannel).toContainEqual(
      expect.objectContaining({ channel: "linkedin", published: 1, impressions: 500 }),
    );
    expect(byChannel).toContainEqual(
      expect.objectContaining({ channel: "email", sent: 1, replied: 1 }),
    );
  });

  it("getWorkspaceInsights aggregates correctly and measures brain completeness", () => {
    const db = createTestDb();
    const wsId = randomUUID();
    insertCampaign(db, wsId, randomUUID(), "C1");

    db.insert(brainDocuments)
      .values([
        { id: randomUUID(), workspaceId: wsId, docType: "soul", content: "filled", createdAt: Date.now(), updatedAt: Date.now() },
        { id: randomUUID(), workspaceId: wsId, docType: "icp", content: "   ", createdAt: Date.now(), updatedAt: Date.now() }, // empty
      ])
      .run();
    db.insert(guidanceOverrides)
      .values({ id: randomUUID(), workspaceId: wsId, channel: "linkedin", content: "X", createdAt: Date.now(), updatedAt: Date.now() })
      .run();

    const insights = getWorkspaceInsights(db, wsId);
    expect(insights.campaigns).toHaveLength(1);
    expect(insights.brain.docs.find(d => d.type === "soul")?.filled).toBe(true);
    expect(insights.brain.docs.find(d => d.type === "icp")?.filled).toBe(false); // only spaces
    expect(insights.brain.docs.find(d => d.type === "voice")?.filled).toBe(false); // missing
    expect(insights.brain.completenessPct).toBe(20); // 1/5 docs filled
    expect(insights.brain.overlayCount).toBe(1);
    expect(insights.brain.campaignCount).toBe(1);
  });
});
