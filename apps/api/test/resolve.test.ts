import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_SECTION_TOKEN_CAP } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { backfillMissingCampaignPlans } from "../src/services/campaign-plan-backfill";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("resolve API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Resolvable" },
    });
    workspaceId = res.json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/voice`,
      payload: { content: "Direct, technical, never corporate." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("resolves a bundle with ordered sections and a trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    const keys = bundle.sections.map((s: { key: string }) => s.key);
    // Sprint 53: the plan rides immediately after the campaign overlay and
    // before persona. Asserted by index arithmetic first, so a future edit of
    // the pinned list below cannot silently move it.
    expect(keys.indexOf("campaign_plan")).toBe(keys.indexOf("campaign") + 1);
    expect(keys.indexOf("campaign_plan")).toBe(keys.indexOf("persona") - 1);
    expect(keys).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "campaign_plan",
      "persona",
      "lead",
      "media_contact",
      "signal",
      "evidence",
      "task",
    ]);
    expect(bundle.prompt).toContain("We exist to end GTM amnesia.");
    expect(bundle.includedTokens).toBeGreaterThan(0);
    expect(bundle.overBudget).toBe(false);
    // empty docs excluded with reasons
    const icp = bundle.sections.find((s: { key: string }) => s.key === "org:icp");
    expect(icp.included).toBe(false);
  });

  it("includes the persona overlay when personaId is given", async () => {
    const persona = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO", overlay: "Write as the founder, first person." },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
    });
    expect(res.statusCode).toBe(200);
    const section = res.json().sections.find((s: { key: string }) => s.key === "persona");
    expect(section.included).toBe(true);
    expect(section.content).toContain("Write as the founder");
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: {
        taskType: "linkedin_post",
        channel: "linkedin",
        personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("persona_not_found");
  });

  it("rejects an invalid task type with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "tiktok_dance", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/resolve",
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("honors a custom token budget", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", tokenBudget: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenBudget).toBe(500);
  });

  // Sprint 53 — the resolver reads the curated plan, so the API layer has to
  // load it. Without this plumbing the section composed in Sprint 53 Task 2 is
  // inert: it is always present and always excluded.
  describe("campaign plan (Sprint 53)", () => {
    async function createCampaign(name: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    async function activatePlan(
      campaignId: string,
      plan: { objective?: string; kpi?: string; pillars?: string[]; guidance?: string },
    ): Promise<void> {
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

    it("populates the campaign_plan section from the active plan revision", async () => {
      const campaignId = await createCampaign("Category creation");
      await activatePlan(campaignId, {
        objective: "Own the phrase GTM amnesia",
        kpi: "Qualified conversations per week",
        pillars: ["Memory beats tooling", "Show the trace"],
        guidance: "Never say synergy.",
      });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();
      const section = bundle.sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(true);
      expect(section.tier).toBe(1);
      expect(section.tokens).toBeGreaterThan(0);
      expect(section.title).toBe("Campaign plan (revision 1)");
      expect(section.content).toContain("Own the phrase GTM amnesia");
      expect(section.content).toContain("Memory beats tooling");
      // …and it actually reaches the prompt, not just the trace.
      expect(bundle.prompt).toContain("Qualified conversations per week");
      expect(bundle.prompt).toContain("Never say synergy.");
    });

    it("degrades to an excluded-with-reason section when the campaign has no plan", async () => {
      const campaignId = await createCampaign("Unplanned");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(false);
      expect(section.tokens).toBe(0);
      expect(section.reason).toContain("no active plan revision");
    });

    it("reports no campaign at all rather than crashing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(false);
      expect(section.reason).toContain("no campaign selected");
    });

    it("resolves the newly activated revision after the plan is edited", async () => {
      const campaignId = await createCampaign("Iterating");
      await activatePlan(campaignId, { objective: "V1", pillars: ["Pillar the first"] });
      await activatePlan(campaignId, { objective: "V2", pillars: ["Pillar the second"] });

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.title).toBe("Campaign plan (revision 2)");
      expect(section.content).toContain("Pillar the second");
      expect(section.content).not.toContain("Pillar the first");
    });
  });

  /**
   * Sprint 53 Task 4 — strategy and instruction stop overlapping.
   *
   * The `campaign` section is the free-text overlay ("additional instruction");
   * the `campaign_plan` section is the curated strategy. The only exception is
   * a campaign with no active plan revision, where the legacy structured block
   * is carried in the campaign section as a **named** fallback so no campaign
   * silently loses its strategy from prompts.
   */
  describe("overlay re-scoping (Sprint 53 Task 4)", () => {
    const STRUCTURED_LABELS = ["Objective:", "KPI:", "Timeframe:", "Audience:", "Messaging pillars:"];
    const ROW = {
      objective: "Row objective — legacy column",
      kpi: "Row KPI — legacy column",
      timeframe: "Row timeframe — legacy column",
      audience: "Row audience — legacy column",
      pillars: ["Row pillar — legacy column"],
      overlay: "Additional instruction: no em dashes this month.",
    };

    async function createStructuredCampaign(name: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name, ...ROW },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    async function activate(campaignId: string, plan: Record<string, unknown>) {
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

    async function resolve(campaignId: string) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();
      const byKey = (key: string) =>
        bundle.sections.find((s: { key: string }) => s.key === key) as {
          key: string;
          content: string;
          included: boolean;
          reason: string;
        };
      return { bundle, campaign: byKey("campaign"), plan: byKey("campaign_plan") };
    }

    it("splits strategy into campaign_plan and instruction into campaign, with no duplication", async () => {
      const campaignId = await createStructuredCampaign("Split brain");
      await activate(campaignId, {
        objective: "Plan objective — the curated one",
        kpi: "Plan KPI — the curated one",
        pillars: ["Plan pillar — the curated one"],
      });

      const { bundle, campaign, plan } = await resolve(campaignId);

      // Instruction only — the structured block is gone.
      expect(campaign.included).toBe(true);
      expect(campaign.content).toBe(ROW.overlay);
      for (const label of STRUCTURED_LABELS) expect(campaign.content).not.toContain(label);
      expect(campaign.reason).not.toMatch(/fallback/i);

      // Strategy only — and it is the *plan's* strategy, not the row's.
      expect(plan.included).toBe(true);
      expect(plan.content).toContain("Plan objective — the curated one");
      expect(plan.content).toContain("Plan pillar — the curated one");

      // No duplication: nothing the plan says is also in the campaign section,
      // and the legacy row values reach the prompt nowhere at all.
      const planLines = plan.content.split("\n").filter((l: string) => l.trim());
      for (const line of planLines) expect(campaign.content).not.toContain(line);
      expect(bundle.prompt).not.toContain(ROW.objective);
      expect(bundle.prompt).not.toContain(ROW.pillars[0]);
      expect(bundle.prompt.split(ROW.overlay).length - 1).toBe(1);
    });

    it("falls back to the legacy structured block when there is no active plan, and says so in the trace", async () => {
      const campaignId = await createStructuredCampaign("Planless");

      const { bundle, campaign, plan } = await resolve(campaignId);

      expect(campaign.included).toBe(true);
      for (const label of STRUCTURED_LABELS) expect(campaign.content).toContain(label);
      expect(campaign.content).toContain(ROW.objective);
      expect(campaign.content).toContain(ROW.overlay);
      expect(bundle.prompt).toContain(ROW.objective);

      // The trace explains the loss instead of hiding it — on both sections.
      expect(campaign.reason).toMatch(/fallback/i);
      expect(campaign.reason).toMatch(/no active plan revision/i);
      expect(plan.included).toBe(false);
      expect(plan.reason).toMatch(/no active plan revision/i);
      expect(plan.reason).toMatch(/fallback/i);
    });

    it("stops falling back once the plan is activated", async () => {
      const campaignId = await createStructuredCampaign("Catching up");
      expect((await resolve(campaignId)).campaign.reason).toMatch(/fallback/i);

      await activate(campaignId, { objective: "Plan objective — the curated one" });

      const { campaign, plan } = await resolve(campaignId);
      expect(campaign.content).toBe(ROW.overlay);
      expect(campaign.reason).not.toMatch(/fallback/i);
      expect(plan.included).toBe(true);
    });

    it("excludes the campaign section when a planned campaign has no additional instruction", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Terse", objective: ROW.objective },
      });
      const campaignId = res.json().id;
      await activate(campaignId, { objective: "Plan objective — the curated one" });

      const { campaign } = await resolve(campaignId);
      expect(campaign.included).toBe(false);
      expect(campaign.content).toBe("");
      expect(campaign.reason).toMatch(/no additional instruction/i);
    });

    /**
     * Sprint 53 review, C1 — the **backfilled** campaign.
     *
     * Every other test here hand-builds its plan through the plan routes, so
     * none of them ever resolved the shape the boot sweep actually produces.
     * That is exactly how the overlay came to appear in the prompt twice: the
     * backfill copied `campaigns.overlay` into `plan.guidance`, so the same
     * bytes shipped as both the campaign section's instruction and the plan
     * section's "Plan guidance". Every pre-existing campaign becomes this shape
     * on the next deploy, so it is the case most worth pinning.
     */
    describe("a backfilled campaign (Sprint 53 review, C1)", () => {
      it("carries the overlay into the prompt exactly once", async () => {
        const campaignId = await createStructuredCampaign("Backfilled");
        await backfillMissingCampaignPlans(db);

        const { bundle, campaign, plan } = await resolve(campaignId);

        // The five strategy columns rehomed to the plan; the free text did not
        // move — it is still the campaign section's additional instruction.
        expect(plan.included).toBe(true);
        expect(plan.content).toContain(ROW.objective);
        expect(plan.content).toContain(ROW.pillars[0]);
        expect(campaign.included).toBe(true);
        expect(campaign.content).toBe(ROW.overlay);
        expect(campaign.reason).not.toMatch(/fallback/i);

        // The plan never gets a second copy of the overlay …
        expect(plan.content).not.toContain(ROW.overlay);
        expect(plan.content).not.toContain("Plan guidance");
        // … so the model sees the instruction once, not twice.
        expect(bundle.prompt.split(ROW.overlay).length - 1).toBe(1);
      });

      it("reflects a post-backfill overlay edit, with the plan still the only strategy", async () => {
        const campaignId = await createStructuredCampaign("Edited after backfill");
        await backfillMissingCampaignPlans(db);

        const editedOverlay = "Additional instruction: cite a customer every time.";
        const editedObjective = "Row objective — typed after the backfill";
        const put = await app.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}`,
          payload: {
            ...ROW,
            name: "Edited after backfill",
            objective: editedObjective,
            overlay: editedOverlay,
          },
        });
        expect(put.statusCode).toBe(200);

        // The instruction the founder edited is what the model sees — once, and
        // the superseded text is gone.
        const { bundle, campaign, plan } = await resolve(campaignId);
        expect(campaign.content).toBe(editedOverlay);
        expect(bundle.prompt).not.toContain(ROW.overlay);
        expect(bundle.prompt.split(editedOverlay).length - 1).toBe(1);

        // Strategy stays the plan's, by design: once a campaign has a plan the
        // row's five strategy columns are not a prompt input, which is why the
        // campaign form renders them read-only in that state
        // (apps/web/.../campaign-form.tsx). The founder cannot type into a dead
        // input, so this is a documented authority boundary, not silent drift.
        expect(plan.content).toContain(ROW.objective);
        expect(bundle.prompt).not.toContain(editedObjective);
      });
    });
  });

  // Sprint 53 Task 5 — the plan form's "what the LLM will see" preview. The
  // founder is typing an unsaved revision, so /resolve accepts the draft inline
  // and composes it *instead of* the stored active plan, without persisting it.
  describe("unsaved plan draft preview (Sprint 53 Task 5)", () => {
    const DRAFT = {
      objective: "Draft objective — still being typed",
      kpi: "Draft KPI — still being typed",
      timeframe: "Q4",
      startAt: null,
      endAt: null,
      audienceIds: [],
      pillars: ["Draft pillar — still being typed"],
      offers: [],
      ctas: [],
      guidance: "Draft guidance — still being typed",
    };

    async function plannedCampaign(): Promise<string> {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Preview me" },
      });
      const campaignId = created.json().id;
      const revision = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: {
          startAt: null,
          endAt: null,
          objective: "Active objective — already saved",
          pillars: ["Active pillar — already saved"],
        },
      });
      expect(revision.statusCode).toBe(201);
      const activated = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.json().id}/activate`,
      });
      expect(activated.statusCode).toBe(200);
      return campaignId;
    }

    it("composes the inline draft instead of the stored active plan", async () => {
      const campaignId = await plannedCampaign();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId,
          campaignPlanDraft: DRAFT,
        },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();
      const section = bundle.sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(true);
      expect(section.content).toContain("Draft objective — still being typed");
      expect(section.content).toContain("Draft pillar — still being typed");
      expect(section.content).not.toContain("Active objective — already saved");
      // The draft is unsaved, so it has no revision number to name.
      expect(section.title).toBe("Campaign plan");
      // …and it reaches the prompt, which is the whole point of the preview.
      expect(bundle.prompt).toContain("Draft guidance — still being typed");
      expect(bundle.prompt).not.toContain("Active pillar — already saved");
    });

    it("never persists the preview — the active plan is untouched afterwards", async () => {
      const campaignId = await plannedCampaign();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId,
          campaignPlanDraft: DRAFT,
        },
      });

      const after = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      const section = after
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.title).toBe("Campaign plan (revision 1)");
      expect(section.content).toContain("Active objective — already saved");
      expect(section.content).not.toContain("Draft objective — still being typed");

      const workspaceView = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/workspace`,
      });
      expect(workspaceView.json().revisions).toHaveLength(1);
    });

    it("rejects a draft that breaks the stored revision's own limits", async () => {
      const campaignId = await plannedCampaign();
      for (const bad of [
        { ...DRAFT, pillars: Array.from({ length: 21 }, (_, i) => `pillar ${i}`) },
        { ...DRAFT, pillars: ["x".repeat(201)] },
        { ...DRAFT, objective: "x".repeat(1_001) },
        { ...DRAFT, guidance: "x".repeat(10_001) },
        { ...DRAFT, startAt: 2_000, endAt: 1_000 },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/resolve`,
          payload: {
            taskType: "linkedin_post",
            channel: "linkedin",
            campaignId,
            campaignPlanDraft: bad,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("invalid_input");
      }
    });

    it("still caps a maximal draft at the plan token cap", async () => {
      const campaignId = await plannedCampaign();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId,
          campaignPlanDraft: {
            ...DRAFT,
            pillars: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "p")),
            guidance: "g".repeat(10_000),
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.tokens).toBeLessThanOrEqual(PLAN_SECTION_TOKEN_CAP);
      expect(section.reason).toMatch(/truncated/i);
    });

    it("ignores a draft when no campaign is in scope", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignPlanDraft: DRAFT },
      });
      expect(res.statusCode).toBe(200);
      const section = res
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign_plan");
      expect(section.included).toBe(false);
      expect(section.reason).toMatch(/no campaign selected/i);
    });

    it("previews the campaign section without its legacy fallback once the draft carries strategy", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: {
          name: "Planless but drafting",
          objective: "Row objective — legacy column",
          overlay: "Additional instruction: no em dashes.",
        },
      });
      const campaignId = created.json().id;

      const before = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: { taskType: "linkedin_post", channel: "linkedin", campaignId },
      });
      expect(
        before.json().sections.find((s: { key: string }) => s.key === "campaign").reason,
      ).toMatch(/fallback/i);

      const after = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/resolve`,
        payload: {
          taskType: "linkedin_post",
          channel: "linkedin",
          campaignId,
          campaignPlanDraft: DRAFT,
        },
      });
      const campaign = after
        .json()
        .sections.find((s: { key: string }) => s.key === "campaign");
      expect(campaign.reason).not.toMatch(/fallback/i);
      expect(campaign.content).toBe("Additional instruction: no em dashes.");
    });
  });
});
