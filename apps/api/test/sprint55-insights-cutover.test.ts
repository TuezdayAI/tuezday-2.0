/**
 * Sprint 55 Task 5 — the /insights cutover snapshot.
 *
 * This suite pins the EXACT output of /insights (campaign level and workspace
 * level, JSON and CSV) against realistic fixtures BEFORE the reads move from
 * the three legacy stores (engagement_metrics, publication_metrics,
 * ad_campaign_metrics) to the unified `metrics` fact table. The pinned
 * literals below were captured against the legacy implementation and MUST NOT
 * be edited during the cutover: Task 5 is a storage change only — no displayed
 * number moves. The four known semantic mixings (spec §2.3 / Task 5b) are
 * reproduced faithfully and fixed later, each in its own commit.
 *
 * Fixtures deliberately cover every aggregation edge the legacy code has:
 *  - publications with 24h-only, 7d-only, and 24h+7d snapshots (prefer-7d);
 *  - null metric columns (absence is not zero);
 *  - a publication on the "ads" channel, so prorated cumulative organic
 *    impressions land in the same channel cell as the all-time paid sum;
 *  - multiple ad campaigns with sync + csv sources, including an all-zero day;
 *  - manual engagement readings: campaign-linked, other-campaign-linked,
 *    subject-less, and linked to a campaign-less draft (only the first kind
 *    reaches learningTotals; none reach byChannel);
 *  - outbound sends, failures, and inbox-derived replies (replies stay
 *    derived from inboxItems — they are not facts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  adAccounts,
  adCampaignMetrics,
  adCampaigns,
  campaigns,
  connections,
  drafts,
  engagementMetrics,
  generations,
  inboxItems,
  launches,
  launchMessages,
  publicationMetrics,
  publications,
} from "../src/db/schema";
import { backfillMetrics } from "../src/services/metrics-backfill";
import { buildAuthedApp, createTestDb } from "./helpers";

// Fixed instants so every pinned number is deterministic.
const T_CREATED = Date.parse("2026-06-01T00:00:00.000Z");
const T_PUBLISHED = Date.parse("2026-06-10T12:00:00.000Z");
const T_CAPTURED_24H = Date.parse("2026-06-11T12:05:00.000Z");
const T_CAPTURED_7D = Date.parse("2026-06-17T12:05:00.000Z");
const T_RECORDED_1 = Date.parse("2026-06-12T09:00:00.000Z");
const T_RECORDED_2 = Date.parse("2026-06-13T09:00:00.000Z");

const CAMPAIGN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CAMPAIGN_B = "bbbbbbbb-0000-4000-8000-000000000002";

let db: Db;
let app: TuezdayApp;
let workspaceId: string;

function insertCampaignRow(id: string, name: string, createdAt: number) {
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
      channelsJson: '["linkedin","x","email","ads"]',
      personaIdsJson: "[]",
      overlay: "",
      status: "active",
      automationMode: "manual",
      autoDailyCap: null,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

function insertDraft(id: string, campaignId: string | null, channel: string, state: string) {
  db.insert(drafts)
    .values({
      id,
      workspaceId,
      campaignId,
      taskType: "linkedin_post",
      channel,
      state,
      originalContent: "c",
      content: "c",
      createdAt: T_CREATED,
      updatedAt: T_CREATED,
    })
    .run();
}

function insertPublication(
  id: string,
  draftId: string,
  connectionId: string,
  status: string,
  publishedAt: number | null,
) {
  db.insert(publications)
    .values({
      id,
      workspaceId,
      draftId,
      connectionId,
      providerKey: "linkedin",
      target: "profile",
      title: id,
      status,
      scheduledFor: T_CREATED,
      publishedAt,
      externalId: `ext-${id}`,
      createdAt: T_CREATED,
      updatedAt: T_CREATED,
    })
    .run();
}

function insertPubMetric(
  publicationId: string,
  window: "24h" | "7d",
  values: {
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    impressions?: number | null;
    clicks?: number | null;
  },
  capturedAt: number,
) {
  db.insert(publicationMetrics)
    .values({
      id: `pm-${publicationId}-${window}`,
      workspaceId,
      publicationId,
      window,
      likes: values.likes ?? null,
      comments: values.comments ?? null,
      shares: values.shares ?? null,
      impressions: values.impressions ?? null,
      clicks: values.clicks ?? null,
      capturedAt,
      createdAt: capturedAt,
    })
    .run();
}

beforeAll(async () => {
  db = createTestDb();
  app = await buildAuthedApp({ db });
  workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Snapshot WS" } })
  ).json().id;
  await app.inject({
    method: "PUT",
    url: `/workspaces/${workspaceId}/brain/soul`,
    payload: { content: "We exist to end GTM amnesia." },
  });

  // --- Campaigns (createdAt fixed so listCampaigns order is deterministic) ---
  insertCampaignRow(CAMPAIGN_A, "Launch", T_CREATED + 1000);
  insertCampaignRow(CAMPAIGN_B, "Background", T_CREATED);

  // --- Drafts ---------------------------------------------------------------
  insertDraft("d-li-1", CAMPAIGN_A, "linkedin", "approved");
  insertDraft("d-li-2", CAMPAIGN_A, "linkedin", "approved");
  insertDraft("d-x-1", CAMPAIGN_A, "x", "approved");
  insertDraft("d-ads-1", CAMPAIGN_A, "ads", "approved");
  insertDraft("d-rej", CAMPAIGN_A, "linkedin", "rejected");
  insertDraft("d-pend", CAMPAIGN_A, "linkedin", "pending_review");
  insertDraft("d-b-1", CAMPAIGN_B, "linkedin", "approved");
  insertDraft("d-nocamp", null, "linkedin", "approved");

  // --- Generations (quality ratings) -----------------------------------------
  const genBase = {
    workspaceId,
    campaignId: CAMPAIGN_A,
    taskType: "linkedin_post",
    channel: "linkedin",
    prompt: "p",
    output: "o",
    model: "m",
    provider: "prov",
    durationMs: 10,
    sectionsJson: "[]",
    createdAt: T_CREATED,
  };
  db.insert(generations)
    .values([
      { ...genBase, id: "gen-1", rating: "accepted" },
      { ...genBase, id: "gen-2", rating: "accepted" },
      { ...genBase, id: "gen-3", rating: "needs_edit" },
      { ...genBase, id: "gen-4", rating: null },
    ])
    .run();

  // --- Publications + platform snapshots -------------------------------------
  const connId = "conn-social-1";
  db.insert(connections)
    .values({
      id: connId,
      workspaceId,
      providerKey: "linkedin",
      status: "active",
      nangoConnectionId: "nango-1",
      configJson: "{}",
      createdAt: T_CREATED,
      updatedAt: T_CREATED,
    })
    .run();

  insertPublication("pub-1", "d-li-1", connId, "published", T_PUBLISHED);
  insertPublication("pub-2", "d-li-2", connId, "published", T_PUBLISHED);
  insertPublication("pub-3", "d-x-1", connId, "published", T_PUBLISHED);
  insertPublication("pub-4", "d-ads-1", connId, "published", T_PUBLISHED);
  insertPublication("pub-sched", "d-pend", connId, "scheduled", null);

  // pub-1 has both windows — the 7d snapshot must win.
  insertPubMetric(
    "pub-1",
    "24h",
    { likes: 5, comments: 1, shares: 0, impressions: 400, clicks: 10 },
    T_CAPTURED_24H,
  );
  insertPubMetric(
    "pub-1",
    "7d",
    { likes: 12, comments: 3, shares: 2, impressions: 900, clicks: 25 },
    T_CAPTURED_7D,
  );
  // pub-2: 24h only, with null comments/shares (absence is not zero).
  insertPubMetric("pub-2", "24h", { likes: 4, impressions: 300, clicks: 8 }, T_CAPTURED_24H);
  // pub-3: 7d only, with null comments/clicks.
  insertPubMetric("pub-3", "7d", { likes: 7, shares: 1, impressions: 500 }, T_CAPTURED_7D);
  // pub-4 is on the "ads" channel — its organic impressions land in the same
  // channel cell as the paid totals (the legacy mixing Task 5b will fix).
  insertPubMetric("pub-4", "24h", { likes: 2, impressions: 200 }, T_CAPTURED_24H);

  // --- Paid: two ad campaigns linked to campaign A ----------------------------
  db.insert(adAccounts)
    .values({
      id: "ad-acc-1",
      workspaceId,
      externalId: "acc-ext-1",
      name: "Tuezday Main",
      currency: "USD",
      createdAt: T_CREATED,
    })
    .run();
  db.insert(adCampaigns)
    .values([
      {
        id: "ad-camp-1",
        workspaceId,
        adAccountId: "ad-acc-1",
        externalId: "ac-ext-1",
        name: "Lead gen June",
        campaignId: CAMPAIGN_A,
        lastSyncedAt: T_CREATED,
        createdAt: T_CREATED,
      },
      {
        id: "ad-camp-2",
        workspaceId,
        adAccountId: "ad-acc-1",
        externalId: "ac-ext-2",
        name: "Retargeting",
        campaignId: CAMPAIGN_A,
        lastSyncedAt: T_CREATED,
        createdAt: T_CREATED,
      },
    ])
    .run();
  db.insert(adCampaignMetrics)
    .values([
      {
        id: "adm-1",
        workspaceId,
        adCampaignId: "ad-camp-1",
        date: "2026-06-11",
        spendCents: 1500,
        impressions: 1000,
        clicks: 50,
        conversions: 5,
        source: "sync",
        createdAt: T_CREATED,
        updatedAt: T_CREATED,
      },
      {
        id: "adm-2",
        workspaceId,
        adCampaignId: "ad-camp-1",
        date: "2026-06-12",
        spendCents: 2000,
        impressions: 1200,
        clicks: 60,
        conversions: 7,
        source: "sync",
        createdAt: T_CREATED,
        updatedAt: T_CREATED,
      },
      // An all-zero imported day: zero was REPORTED (not absent) and must sum as zero.
      {
        id: "adm-3",
        workspaceId,
        adCampaignId: "ad-camp-2",
        date: "2026-06-11",
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        source: "csv",
        createdAt: T_CREATED,
        updatedAt: T_CREATED,
      },
    ])
    .run();

  // --- Manual engagement readings ---------------------------------------------
  db.insert(engagementMetrics)
    .values([
      // Linked to campaign A drafts — the ONLY rows in A's learningTotals.
      {
        id: "em-1",
        workspaceId,
        draftId: "d-li-1",
        channel: "linkedin",
        description: "June launch post",
        impressions: 100,
        engagements: 20,
        clicks: 5,
        recordedAt: T_RECORDED_1,
        createdAt: T_RECORDED_1,
      },
      {
        id: "em-2",
        workspaceId,
        draftId: "d-li-2",
        channel: "linkedin",
        description: "Follow-up post",
        impressions: null,
        engagements: null,
        clicks: 3,
        recordedAt: T_RECORDED_2,
        createdAt: T_RECORDED_2,
      },
      // Linked to campaign B — must NOT appear in A.
      {
        id: "em-b",
        workspaceId,
        draftId: "d-b-1",
        channel: "linkedin",
        description: "B post",
        impressions: 999,
        engagements: 99,
        clicks: null,
        recordedAt: T_RECORDED_1,
        createdAt: T_RECORDED_1,
      },
      // Subject-less — excluded from every campaign (legacy inner join).
      {
        id: "em-nosubj",
        workspaceId,
        draftId: null,
        channel: "x",
        description: "Loose reading",
        impressions: 50,
        engagements: null,
        clicks: null,
        recordedAt: T_RECORDED_1,
        createdAt: T_RECORDED_1,
      },
      // Linked to a draft with no campaign — also excluded from every campaign.
      {
        id: "em-nocamp",
        workspaceId,
        draftId: "d-nocamp",
        channel: "linkedin",
        description: "Campaign-less",
        impressions: null,
        engagements: 7,
        clicks: null,
        recordedAt: T_RECORDED_2,
        createdAt: T_RECORDED_2,
      },
    ])
    .run();

  // --- Outbound + replies -------------------------------------------------------
  db.insert(launches)
    .values({
      id: "launch-1",
      workspaceId,
      campaignId: CAMPAIGN_A,
      name: "L1",
      channelsJson: "[]",
      createdAt: T_CREATED,
      updatedAt: T_CREATED,
    })
    .run();
  db.insert(launchMessages)
    .values([
      { id: "lm-1", workspaceId, launchId: "launch-1", channel: "email", kind: "broadcast", status: "sent", createdAt: T_CREATED, updatedAt: T_CREATED },
      { id: "lm-2", workspaceId, launchId: "launch-1", channel: "email", kind: "broadcast", status: "sent", createdAt: T_CREATED, updatedAt: T_CREATED },
      { id: "lm-3", workspaceId, launchId: "launch-1", channel: "linkedin", kind: "broadcast", status: "sent", createdAt: T_CREATED, updatedAt: T_CREATED },
      { id: "lm-4", workspaceId, launchId: "launch-1", channel: "email", kind: "broadcast", status: "failed", createdAt: T_CREATED, updatedAt: T_CREATED },
    ])
    .run();
  db.insert(connections)
    .values({
      id: "conn-inbox-1",
      workspaceId,
      providerKey: "google",
      status: "active",
      nangoConnectionId: "nango-2",
      configJson: "{}",
      createdAt: T_CREATED,
      updatedAt: T_CREATED,
    })
    .run();
  const inboxBase = {
    workspaceId,
    connectionId: "conn-inbox-1",
    providerKey: "google",
    kind: "dm",
    channel: "email",
    content: "reply",
    externalCreatedAt: T_CREATED,
    createdAt: T_CREATED,
    updatedAt: T_CREATED,
  };
  db.insert(inboxItems)
    .values([
      { ...inboxBase, id: "inbox-1", externalId: "ie-1", launchMessageId: "lm-1" },
      { ...inboxBase, id: "inbox-2", externalId: "ie-2", launchMessageId: "lm-2" },
      // Unlinked item — never counted as a reply.
      { ...inboxBase, id: "inbox-3", externalId: "ie-3", launchMessageId: null },
    ])
    .run();

  // Mirror production boot: the backfill maps every legacy row into the
  // unified fact table (app.ts runs this at startup; fixtures landed after).
  backfillMetrics(db);
});

afterAll(async () => {
  await app.close();
});

describe("sprint 55 — /insights snapshot (the cutover must not move a number)", () => {
  it("campaign-level insights match the pinned legacy output exactly", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/campaigns/${CAMPAIGN_A}/insights`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
  "campaign": {
    "id": "aaaaaaaa-0000-4000-8000-000000000001",
    "name": "Launch",
    "status": "active"
  },
  "paid": {
    "totals": {
      "spendCents": 3500,
      "impressions": 2200,
      "clicks": 110,
      "conversions": 12
    },
    "adCampaigns": [
      {
        "id": "ad-camp-1",
        "name": "Lead gen June",
        "accountName": "Tuezday Main",
        "currency": "USD",
        "totals": {
          "spendCents": 3500,
          "impressions": 2200,
          "clicks": 110,
          "conversions": 12
        }
      },
      {
        "id": "ad-camp-2",
        "name": "Retargeting",
        "accountName": "Tuezday Main",
        "currency": "USD",
        "totals": {
          "spendCents": 0,
          "impressions": 0,
          "clicks": 0,
          "conversions": 0
        }
      }
    ]
  },
  "organic": {
    "publishedCount": 4,
    "scheduledCount": 1,
    "platform": {
      "likes": 25,
      "comments": 3,
      "shares": 3,
      "impressions": 1900,
      "clicks": 33
    },
    "learning": {
      "impressions": 100,
      "engagements": 20,
      "clicks": 8
    }
  },
  "outbound": {
    "launchCount": 1,
    "sentCount": 3,
    "failedCount": 1,
    "repliedCount": 2,
    "replyRate": 0.6667
  },
  "outreach": {
    "sent": 0,
    "opened": 0,
    "clicked": 0,
    "replied": 0,
    "positive": 0,
    "meetings": 0,
    "won": 0,
    "lost": 0,
    "sequenceCount": 0,
    "replyRate": 0,
    "positiveRate": 0
  },
  "quality": {
    "draftCounts": {
      "draft": 0,
      "pending_review": 1,
      "approved": 4,
      "rejected": 1,
      "edited": 0
    },
    "approvalRate": 0.8,
    "ratings": {
      "accepted": 2,
      "needs_edit": 1,
      "rejected": 0
    }
  },
  "byChannel": [
    {
      "channel": "ads",
      "published": 1,
      "impressions": 2675,
      "spendCents": 3500,
      "sent": 0,
      "replied": 0
    },
    {
      "channel": "linkedin",
      "published": 2,
      "impressions": 950,
      "spendCents": 0,
      "sent": 1,
      "replied": 0
    },
    {
      "channel": "x",
      "published": 1,
      "impressions": 475,
      "spendCents": 0,
      "sent": 0,
      "replied": 0
    },
    {
      "channel": "email",
      "published": 0,
      "impressions": 0,
      "spendCents": 0,
      "sent": 2,
      "replied": 2
    }
  ]
});
  });

  it("workspace-level insights match the pinned legacy output exactly", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/insights`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
  "campaigns": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000001",
      "name": "Launch",
      "status": "active",
      "spendCents": 3500,
      "publishedCount": 4,
      "sentCount": 3,
      "approvalRate": 0.8
    },
    {
      "id": "bbbbbbbb-0000-4000-8000-000000000002",
      "name": "Background",
      "status": "active",
      "spendCents": 0,
      "publishedCount": 0,
      "sentCount": 0,
      "approvalRate": 1
    }
  ],
  "byChannel": [
    {
      "channel": "ads",
      "published": 1,
      "impressions": 2675,
      "spendCents": 3500,
      "sent": 0,
      "replied": 0
    },
    {
      "channel": "linkedin",
      "published": 2,
      "impressions": 950,
      "spendCents": 0,
      "sent": 1,
      "replied": 0
    },
    {
      "channel": "x",
      "published": 1,
      "impressions": 475,
      "spendCents": 0,
      "sent": 0,
      "replied": 0
    },
    {
      "channel": "email",
      "published": 0,
      "impressions": 0,
      "spendCents": 0,
      "sent": 2,
      "replied": 2
    }
  ],
  "brain": {
    "docs": [
      {
        "type": "soul",
        "filled": true
      },
      {
        "type": "icp",
        "filled": false
      },
      {
        "type": "voice",
        "filled": false
      },
      {
        "type": "history",
        "filled": false
      },
      {
        "type": "now",
        "filled": false
      }
    ],
    "overlayCount": 0,
    "personaCount": 0,
    "campaignCount": 2,
    "generationsTotal": 4,
    "completenessPct": 20
  }
});
  });

  it("campaign CSV export matches the pinned legacy output exactly", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/campaigns/${CAMPAIGN_A}/insights?format=csv`,
    });
    expect(res.statusCode).toBe(200);
    console.log("CAMPAIGN_CSV_SNAPSHOT_START\n" + res.body + "\nCAMPAIGN_CSV_SNAPSHOT_END");
    expect(res.body).toEqual("Section,Metric,Value\nPaid,Spend (cents),3500\nPaid,Impressions,2200\nPaid,Clicks,110\nPaid,Conversions,12\nPaid,CTR (%),5.00\nPaid,CPC,0.32\nPaid - Lead gen June,Spend (USD cents),3500\nPaid - Retargeting,Spend (USD cents),0\nOrganic,Published,4\nOrganic,Scheduled,1\nOrganic - Platform,Likes,25\nOrganic - Platform,Comments,3\nOrganic - Platform,Shares,3\nOrganic - Platform,Impressions,1900\nOrganic - Platform,Clicks,33\nOrganic - Learning,Impressions,100\nOrganic - Learning,Engagements,20\nOrganic - Learning,Clicks,8\nOutbound,Launches,1\nOutbound,Sent,3\nOutbound,Failed,1\nOutbound,Replied,2\nOutbound,Reply rate,66.67%\nQuality - Drafts,draft,0\nQuality - Drafts,pending_review,1\nQuality - Drafts,approved,4\nQuality - Drafts,rejected,1\nQuality - Drafts,edited,0\nQuality,Approval rate,80.00%\nQuality - Ratings,accepted,2\nQuality - Ratings,needs_edit,1\nQuality - Ratings,rejected,0\n\nChannel,Published,Impressions,Spend (cents),Sent,Replied\nads,1,2675,3500,0,0\nlinkedin,2,950,0,1,0\nx,1,475,0,0,0\nemail,0,0,0,2,2\n");
  });

  it("campaign B sees only its own draft-linked manual readings", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/campaigns/${CAMPAIGN_B}/insights`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // em-b only: the subject-less reading and the campaign-less-draft reading
    // are excluded (legacy: inner join through drafts.campaignId).
    expect(body.organic.learning).toEqual({ impressions: 999, engagements: 99, clicks: 0 });
    expect(body.byChannel).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance guard: /insights reads ONE table. The insights service must not
// touch the three legacy metric stores — its metric reads all go through the
// unified `metrics` fact table. (`replies` stay derived from inboxItems, and
// entity tables — drafts, publications, launches — are identity, not metrics.)
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";

describe("sprint 55 — insights reads one table", () => {
  const read = (rel: string) =>
    readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

  it("insights.ts imports none of the legacy metric stores", () => {
    const src = read("services/insights.ts");
    expect(src).not.toMatch(/\bengagementMetrics\b/);
    expect(src).not.toMatch(/\bpublicationMetrics\b/);
    expect(src).not.toMatch(/\badCampaignMetrics\b/);
    expect(src).toMatch(/\bmetrics\b/);
  });

  it("the paid read (getCampaignAdMetrics) is fact-backed", () => {
    const src = read("services/ads.ts");
    const fn = src.slice(src.indexOf("export function getCampaignAdMetrics"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).not.toContain("adCampaignMetrics");
    expect(body).toContain("metrics");
  });
});
