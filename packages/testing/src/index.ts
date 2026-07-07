import type { Workspace } from "@tuezday/contracts";

/** Deterministic workspace fixture for tests. */
export function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    name: "Fixture Workspace",
    websiteUrl: null,
    onboardingStep: null,
    createdAt: 1765400000000,
    updatedAt: 1765400000000,
    ...overrides,
  };
}
