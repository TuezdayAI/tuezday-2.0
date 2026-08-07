import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaignSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { backfillMissingCampaignPlans } from "../src/services/campaign-plan-backfill";
import {
  composeCampaignOverlay,
  composeResolveCampaign,
  getCampaign,
} from "../src/services/campaigns";
import { campaignPlanInput } from "../src/services/resolve-input";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated output.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

const CAMPAIGN_PAYLOAD = {
  name: "Q3 GTM memory push",
  objective: "Position Tuezday as the GTM memory layer",
  kpi: "20 demo calls booked",
  timeframe: "Jul-Sep 2026",
  audience: "Founder-led SaaS teams",
  pillars: ["GTM that remembers", "Brain before pipeline"],
  channels: ["linkedin", "email"],
  overlay: "This quarter we lead hard on the memory problem.",
};

describe("campaigns API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeGateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Campy" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createCampaign(payload: Record<string, unknown> = CAMPAIGN_PAYLOAD) {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload,
      })
    ).json();
  }

  describe("CRUD", () => {
    it("creates a campaign", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: CAMPAIGN_PAYLOAD,
      });
      expect(res.statusCode).toBe(201);
      const campaign = res.json();
      expect(campaignSchema.safeParse(campaign).success).toBe(true);
      expect(campaign.status).toBe("active");
      expect(campaign.pillars).toEqual(CAMPAIGN_PAYLOAD.pillars);
    });

    it("rejects an empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: " " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("lists campaigns", async () => {
      await createCampaign();
      await createCampaign({ ...CAMPAIGN_PAYLOAD, name: "Second" });
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns` })
      ).json();
      expect(list).toHaveLength(2);
    });

    it("updates and archives a campaign", async () => {
      const campaign = await createCampaign();
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        payload: { ...CAMPAIGN_PAYLOAD, name: "Renamed", status: "archived" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("Renamed");
      expect(res.json().status).toBe("archived");
    });

    it("returns 404 for an unknown campaign", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/7c9e6679-7425-40de-944b-e07fc1f90ae7`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("resolver integration", () => {
    // Sprint 53: this campaign has no active plan revision, so the structured
    // block it asserts on now arrives through the legacy-strategy **fallback**
    // rather than through `composeCampaignOverlay`. The assertions are
    // unchanged on purpose — the fallback exists precisely so that a plan-less
    // campaign's prompt does not move. The reason is asserted so the test
    // cannot pass for the wrong reason. The plan-present behaviour lives in
    // `resolve.test.ts` → "overlay re-scoping (Sprint 53 Task 4)".
    it("includes the legacy strategy block when the campaign has no active plan", async () => {
      const campaign = await createCampaign();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(200);
      const section = res.json().sections.find((s: { key: string }) => s.key === "campaign");
      expect(section.included).toBe(true);
      expect(section.title).toContain("Q3 GTM memory push");
      expect(section.content).toContain("Position Tuezday as the GTM memory layer");
      expect(section.content).toContain("GTM that remembers");
      expect(section.content).toContain("memory problem");
      expect(section.content).toContain("20 demo calls");
      expect(section.reason).toMatch(/fallback/i);
    });

    it("keeps the campaign slot excluded without a campaignId", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      const section = res.json().sections.find((s: { key: string }) => s.key === "campaign");
      expect(section.included).toBe(false);
    });

    it("returns 404 for an unknown campaignId", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("campaign_not_found");
    });

    it("refuses an archived campaign with 409", async () => {
      const campaign = await createCampaign();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        payload: { ...CAMPAIGN_PAYLOAD, status: "archived" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("campaign_archived");
    });

    it("refuses generation for a paused campaign", async () => {
      const campaign = await createCampaign();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        payload: { ...CAMPAIGN_PAYLOAD, status: "paused" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("campaign_inactive");
    });
  });

  describe("tagging", () => {
    it("tags generations and submitted drafts with the campaign", async () => {
      const campaign = await createCampaign();
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      expect(gen.campaignId).toBe(campaign.id);

      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      expect(draft.campaignId).toBe(campaign.id);
    });

    it("tags signal-response drafts with the campaign", async () => {
      const campaign = await createCampaign();
      const signal = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals`,
          payload: { content: "Market complaint", source: "reddit" },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/signals/${signal.id}/draft`,
          payload: { channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      expect(draft.campaignId).toBe(campaign.id);
    });

    it("filters drafts by campaign", async () => {
      const campaign = await createCampaign();
      const tagged = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${tagged.id}/submit`,
      });
      const untagged = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${untagged.id}/submit`,
      });

      const filtered = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/drafts?campaignId=${campaign.id}`,
        })
      ).json();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].campaignId).toBe(campaign.id);
    });

    it("reports draft counts by state on the campaign detail", async () => {
      const campaign = await createCampaign();
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", campaignId: campaign.id },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });

      const detail = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
        })
      ).json();
      expect(detail.campaign.id).toBe(campaign.id);
      expect(detail.draftCounts.approved).toBe(1);
      expect(detail.drafts).toHaveLength(1);
      expect(detail.drafts[0].state).toBe("approved");
    });
  });

  /**
   * Sprint 53 Task 4 (decision D3a) — the plan wins.
   *
   * `composeCampaignOverlay` used to concatenate the campaign row's structured
   * columns and *then* the free text, making the row the third home of campaign
   * strategy. It is now the free text alone: "additional instruction".
   *
   * The legacy block survives only as a **fallback** for a campaign with no
   * active plan revision — see the fallback describe below for why that case is
   * not hypothetical.
   */
  describe("overlay re-scoping (Sprint 53)", () => {
    const STRUCTURED_LABELS = [
      "Objective:",
      "KPI:",
      "Timeframe:",
      "Audience:",
      "Messaging pillars:",
    ];

    async function activatePlan(
      campaignId: string,
      plan: { objective?: string; kpi?: string; pillars?: string[] },
    ) {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: { startAt: null, endAt: null, ...plan },
      });
      expect(created.statusCode).toBe(201);
      const activated = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${created.json().id}/activate`,
      });
      expect(activated.statusCode).toBe(200);
    }

    it("composes the free text alone — never the structured block", async () => {
      const created = await createCampaign();
      await activatePlan(created.id, { objective: "Own the phrase GTM amnesia" });
      const campaign = (await getCampaign(db, workspaceId, created.id))!;

      const overlay = composeCampaignOverlay(campaign);
      expect(overlay).toBe(CAMPAIGN_PAYLOAD.overlay);
      for (const label of STRUCTURED_LABELS) expect(overlay).not.toContain(label);
    });

    it("composes the free text alone even with no plan (the composer is plan-blind)", async () => {
      const created = await createCampaign();
      const campaign = (await getCampaign(db, workspaceId, created.id))!;
      expect(composeCampaignOverlay(campaign)).toBe(CAMPAIGN_PAYLOAD.overlay);
    });

    it("keeps objective/pillars on the resolve campaign for the zoom query", async () => {
      const created = await createCampaign();
      await activatePlan(created.id, { objective: "Own the phrase GTM amnesia" });
      const campaign = (await getCampaign(db, workspaceId, created.id))!;

      const resolveCampaign = composeResolveCampaign(
        campaign,
        await campaignPlanInput(db, workspaceId, created.id),
      );
      // Regression guard: composeZoomQuery (packages/brain/src/zoom.ts:57-61)
      // is a separate consumer of these two fields and must not lose them.
      expect(resolveCampaign.objective).toBe(CAMPAIGN_PAYLOAD.objective);
      expect(resolveCampaign.pillars).toEqual(CAMPAIGN_PAYLOAD.pillars);
      expect(resolveCampaign.overlay).toBe(CAMPAIGN_PAYLOAD.overlay);
      expect(resolveCampaign.legacyStrategyFallback).toBe(false);
    });

    /**
     * The gap Task 3's report flagged, widened by what the code actually does:
     * campaign creation does **not** mint a plan (nothing in `routes/campaigns.ts`
     * touches `backfillCampaignControlPlane`), and the boot sweep only runs at
     * boot. So "no active plan revision" covers every campaign created since the
     * last boot, plus every campaign whose activation failed validation.
     * Without the fallback those campaigns would silently lose objective / KPI /
     * timeframe / audience / pillars from every prompt.
     */
    describe("no active plan revision → legacy fallback", () => {
      it("carries the structured block plus the free text, flagged for the trace", async () => {
        const created = await createCampaign();
        const campaign = (await getCampaign(db, workspaceId, created.id))!;
        expect(await campaignPlanInput(db, workspaceId, created.id)).toBeUndefined();

        const resolveCampaign = composeResolveCampaign(campaign, undefined);
        expect(resolveCampaign.legacyStrategyFallback).toBe(true);
        for (const label of STRUCTURED_LABELS) {
          expect(resolveCampaign.overlay).toContain(label);
        }
        expect(resolveCampaign.overlay).toContain(CAMPAIGN_PAYLOAD.objective);
        expect(resolveCampaign.overlay).toContain(CAMPAIGN_PAYLOAD.pillars[0]);
        // The free text is still last, so instruction follows strategy.
        expect(resolveCampaign.overlay.endsWith(CAMPAIGN_PAYLOAD.overlay)).toBe(true);
      });

      it("stops falling back as soon as the campaign has an active plan", async () => {
        const created = await createCampaign();
        const campaign = (await getCampaign(db, workspaceId, created.id))!;
        expect(
          composeResolveCampaign(campaign, await campaignPlanInput(db, workspaceId, created.id))
            .legacyStrategyFallback,
        ).toBe(true);

        // The Task 3 boot sweep, run explicitly — the same thing that happens
        // to every pre-existing campaign on the next deploy.
        await backfillMissingCampaignPlans(db);

        const after = composeResolveCampaign(
          campaign,
          await campaignPlanInput(db, workspaceId, created.id),
        );
        expect(after.legacyStrategyFallback).toBe(false);
        expect(after.overlay).toBe(CAMPAIGN_PAYLOAD.overlay);
      });

      it("treats a contentless plan as no plan rather than dropping strategy", async () => {
        const created = await createCampaign();
        await activatePlan(created.id, {});
        const campaign = (await getCampaign(db, workspaceId, created.id))!;

        const resolveCampaign = composeResolveCampaign(
          campaign,
          await campaignPlanInput(db, workspaceId, created.id),
        );
        // An activated-but-empty plan composes to an *excluded* plan section, so
        // the fallback must trigger on "the plan section would be empty", not on
        // "a revision row exists".
        expect(resolveCampaign.legacyStrategyFallback).toBe(true);
        expect(resolveCampaign.overlay).toContain(CAMPAIGN_PAYLOAD.objective);
      });
    });
  });

  /**
   * Sprint 53 review (I4) — the invariant, enforced instead of assumed.
   *
   * `composeResolveCampaign(campaign, plan)` and `resolveContext`'s
   * `campaignPlan` must be composed from the **same** plan: the first decides
   * whether to fold the legacy structured block into the overlay and sets
   * `legacyStrategyFallback`, the second is what the `campaign_plan` section is
   * composed from. Give them different plans and the trace contradicts itself.
   *
   * Fifteen call sites held that by convention and nothing checked it, so the
   * pairing now lives in one helper — and this test keeps it there.
   */
  describe("the campaign and plan resolver inputs are paired in one place", () => {
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const PAIRING_MODULE = join(SRC, "services", "resolve-input.ts");

    function tsFiles(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return tsFiles(path);
        return path.endsWith(".ts") ? [path] : [];
      });
    }

    it("has no caller composing the two inputs separately", () => {
      const offenders = tsFiles(SRC)
        .filter((path) => path !== PAIRING_MODULE)
        .filter((path) => {
          const source = readFileSync(path, "utf8");
          // A call — not the declaration itself, a type import, or a
          // doc-comment mention.
          return (
            /(?<!function )\bcomposeResolveCampaign\(/.test(source) ||
            /(?<!function )\bcampaignPlanInput\(/.test(source)
          );
        });
      expect(offenders).toEqual([]);
    });

    it("keeps that helper the only producer of both", () => {
      const source = readFileSync(PAIRING_MODULE, "utf8");
      expect(source).toContain("export function campaignResolveInputs(");
      expect(source).toContain("export function campaignResolvePreviewInputs(");
    });
  });
});
