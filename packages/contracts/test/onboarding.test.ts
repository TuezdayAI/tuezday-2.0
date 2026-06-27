import { expect, test } from "vitest";
import { BRAIN_DOC_TEMPLATES, onboardingStepSchema } from "../src/index.js";

test("BRAIN_DOC_TEMPLATES has >= 1 entry with five doc keys present", () => {
  expect(BRAIN_DOC_TEMPLATES.length).toBeGreaterThanOrEqual(1);
  for (const template of BRAIN_DOC_TEMPLATES) {
    expect(template.id).toBeDefined();
    expect(template.label).toBeDefined();
    expect(template.docs).toBeDefined();
    expect(template.docs.soul).toBeDefined();
    expect(template.docs.icp).toBeDefined();
    expect(template.docs.voice).toBeDefined();
    expect(template.docs.history).toBeDefined();
    expect(template.docs.now).toBeDefined();
  }
});

test("onboardingStepSchema validates a step", () => {
  const validStep = {
    key: "workspace",
    label: "Create workspace",
    done: true,
    cta: "/workspaces/123",
  };
  expect(() => onboardingStepSchema.parse(validStep)).not.toThrow();

  const invalidStep = {
    key: "invalid",
    label: "Create workspace",
    done: true,
    cta: "/workspaces/123",
  };
  expect(() => onboardingStepSchema.parse(invalidStep)).toThrow();
});
