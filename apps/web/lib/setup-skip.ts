export interface SetupSkipRequest {
  path: string;
  method: "POST" | "PATCH";
  payload:
    | { name: "My workspace"; onboardingStep: "done" }
    | { step: "done" };
}

export function isSetupSkipEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function buildSetupSkipRequest(workspaceId: string | null): SetupSkipRequest {
  if (workspaceId) {
    return {
      path: `/workspaces/${workspaceId}/onboarding`,
      method: "PATCH",
      payload: { step: "done" },
    };
  }

  return {
    path: "/workspaces",
    method: "POST",
    payload: { name: "My workspace", onboardingStep: "done" },
  };
}
