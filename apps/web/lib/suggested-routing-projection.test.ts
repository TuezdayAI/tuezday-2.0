import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const discoveryPage = readFileSync(
  new URL("../app/workspaces/[id]/discovery/page.tsx", import.meta.url),
  "utf8",
);
const contentPage = readFileSync(
  new URL("../app/workspaces/[id]/content/page.tsx", import.meta.url),
  "utf8",
);

/**
 * Sprint 53 (D3b): the API still returns `suggestedPersonaId` /
 * `suggestedCampaignId` on `signalSchema` and `discoveredItemSchema`, but they
 * are now derived from the top-scoring match rather than stored columns. Both
 * read sites must keep consuming them, and neither may start treating them as
 * something the client writes back.
 */
describe("web read sites consume the derived routing projection", () => {
  it("labels triage inbox items with the derived persona and campaign", () => {
    expect(discoveryPage).toContain(
      "const persona = personaName(item.suggestedPersonaId);",
    );
    expect(discoveryPage).toContain(
      "const campaign = campaignName(item.suggestedCampaignId);",
    );
    // The names are actually rendered, not just computed.
    expect(discoveryPage).toMatch(/\{persona\b/);
    expect(discoveryPage).toMatch(/\{campaign\b/);
    // Records the projection so the next reader does not mistake these for
    // stored columns.
    expect(discoveryPage).toContain("derived from the item's top-scoring match");
  });

  it("pre-fills the Draft response persona and campaign from the projection", () => {
    expect(contentPage).toContain(
      'setDraftPersonaId(s.suggestedPersonaId ?? "");',
    );
    expect(contentPage).toContain(
      'setDraftCampaignId(s.suggestedCampaignId ?? "");',
    );
    expect(contentPage).toContain("Draft response");
    expect(contentPage).toContain(
      "derived from the signal's top-scoring match",
    );
  });

  it("keeps the local SignalView type in step with the API contract", () => {
    expect(contentPage).toContain("suggestedPersonaId: string | null;");
    expect(contentPage).toContain("suggestedCampaignId: string | null;");
  });

  it("never reaches for the raw database column names", () => {
    for (const page of [discoveryPage, contentPage]) {
      expect(page).not.toContain("suggested_persona_id");
      expect(page).not.toContain("suggested_campaign_id");
    }
  });
});
