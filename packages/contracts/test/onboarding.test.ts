import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  ONBOARDING_CURSORS,
  workspaceSchema,
  createWorkspaceInputSchema,
  updateUserInputSchema,
} from "../src/index";

describe("onboarding contracts", () => {
  it("lists the seven visible steps in order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "name", "website", "connect", "verify", "brain", "campaign", "draft",
    ]);
  });

  it("cursors add a terminal 'done'", () => {
    expect(ONBOARDING_CURSORS).toEqual([...ONBOARDING_STEPS, "done"]);
  });

  it("workspaceSchema accepts null website + cursor", () => {
    const base = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "X", createdAt: 1, updatedAt: 1 };
    expect(workspaceSchema.safeParse({ ...base, websiteUrl: null, onboardingStep: null }).success).toBe(true);
    expect(workspaceSchema.safeParse({ ...base, websiteUrl: "https://a.co", onboardingStep: "connect" }).success).toBe(true);
  });

  it("createWorkspaceInputSchema takes an optional valid URL, rejects a bad one", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "X" }).success).toBe(true);
    expect(createWorkspaceInputSchema.safeParse({ name: "X", websiteUrl: "https://a.co" }).success).toBe(true);
    expect(createWorkspaceInputSchema.safeParse({ name: "X", websiteUrl: "not-a-url" }).success).toBe(false);
  });

  it("updateUserInputSchema trims and bounds the name", () => {
    expect(updateUserInputSchema.safeParse({ name: "  Ada  " }).data?.name).toBe("Ada");
    expect(updateUserInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(updateUserInputSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});
