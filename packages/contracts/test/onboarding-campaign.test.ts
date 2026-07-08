import { describe, expect, it } from "vitest";
import {
  ONBOARDING_FREQUENCIES,
  ONBOARDING_FREQUENCY_LABELS,
  frequencyOverlayLine,
  onboardingQuickCampaign,
  taskTypeForChannel,
  upsertCampaignInputSchema,
  CHANNELS,
  TASK_TYPES,
} from "../src/index";

describe("taskTypeForChannel", () => {
  it("maps every channel to a real broadcast task type", () => {
    for (const channel of CHANNELS) {
      expect(TASK_TYPES).toContain(taskTypeForChannel(channel));
    }
    expect(taskTypeForChannel("linkedin")).toBe("linkedin_post");
    expect(taskTypeForChannel("instagram")).toBe("instagram_post");
    expect(taskTypeForChannel("email")).toBe("cold_email_opener");
    expect(taskTypeForChannel("ads")).toBe("ad_copy_variant");
    expect(taskTypeForChannel("web")).toBe("landing_page_hero");
    expect(taskTypeForChannel("pr")).toBe("press_boilerplate");
    expect(taskTypeForChannel("x")).toBe("linkedin_post"); // no broadcast X task; x_dm is per-lead
  });
});

describe("frequencyOverlayLine", () => {
  it("renders the resolver-visible intent line for each frequency", () => {
    for (const f of ONBOARDING_FREQUENCIES) {
      const line = frequencyOverlayLine(f);
      expect(line).toContain("Posting frequency intent:");
      expect(line).toContain(ONBOARDING_FREQUENCY_LABELS[f]);
    }
  });
});

describe("onboardingQuickCampaign", () => {
  it("maps the quick form and round-trips the campaign schema", () => {
    const input = onboardingQuickCampaign({
      workspaceName: "Hexalog",
      goal: "  Launch our new hex packing feature  ",
      channels: ["linkedin", "x"],
      frequency: "3x_week",
    });
    const parsed = upsertCampaignInputSchema.parse(input);
    expect(parsed.name).toBe("Hexalog launch");
    expect(parsed.objective).toBe("Launch our new hex packing feature");
    expect(parsed.channels).toEqual(["linkedin", "x"]);
    expect(parsed.overlay).toContain("3x per week");
    expect(parsed.status).toBe("active");
  });

  it("honours an explicit campaign name", () => {
    const input = onboardingQuickCampaign({
      workspaceName: "Hexalog",
      goal: "g",
      channels: ["email"],
      frequency: "weekly",
      name: "  Summer push  ",
    });
    expect(input.name).toBe("Summer push");
  });
});
