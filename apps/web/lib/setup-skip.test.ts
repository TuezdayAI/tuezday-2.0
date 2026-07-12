import { describe, expect, it } from "vitest";
import { buildSetupSkipRequest, isSetupSkipEnabled } from "./setup-skip";

describe("local setup skip", () => {
  it("is enabled only by the exact public flag value", () => {
    expect(isSetupSkipEnabled(undefined)).toBe(false);
    expect(isSetupSkipEnabled("false")).toBe(false);
    expect(isSetupSkipEnabled("TRUE")).toBe(false);
    expect(isSetupSkipEnabled("true")).toBe(true);
  });

  it("creates an already-complete empty workspace when no workspace exists", () => {
    expect(buildSetupSkipRequest(null)).toEqual({
      path: "/workspaces",
      method: "POST",
      payload: { name: "My workspace", onboardingStep: "done" },
    });
  });

  it("completes the resumed workspace instead of creating another one", () => {
    expect(buildSetupSkipRequest("workspace-123")).toEqual({
      path: "/workspaces/workspace-123/onboarding",
      method: "PATCH",
      payload: { step: "done" },
    });
  });
});
