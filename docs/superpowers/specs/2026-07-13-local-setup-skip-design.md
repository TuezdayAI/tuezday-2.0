# Local Setup Skip Design

Date: 2026-07-13  
Status: Approved for implementation planning

## Goal

Let authenticated local and staging users bypass the guided setup flow and enter an empty workspace immediately when they only need to inspect or test the platform UI.

## Scope

- Add a `Skip setup for now` action to the onboarding wizard.
- Show the action only when `NEXT_PUBLIC_ENABLE_SETUP_SKIP=true`.
- Reuse the existing workspace create and onboarding-cursor APIs.
- Create an empty workspace; do not seed campaigns, content, connections, Brain documents, or other demo data.
- Do not modify login, authentication, session handling, admin credentials, environment loading, or the parallel dev-admin bootstrap work.
- Preserve the normal production onboarding flow when the flag is absent or false.

## User experience

The skip action is available throughout the onboarding wizard when the feature flag is enabled. It is visually secondary to the normal step action and clearly labeled as a temporary bypass.

When no workspace exists yet, selecting it creates a workspace named `My workspace` with its onboarding cursor set to `done`, then routes to `/workspaces/[workspaceId]`.

When the wizard is resuming an existing workspace, selecting it patches that workspace's onboarding cursor to `done`, then routes to `/workspaces/[workspaceId]`.

While the request is running, the action is disabled and displays `Skipping…`. API failures remain on the onboarding page and use its existing error presentation. A failed request must not navigate or leave the UI in a permanently busy state.

## Architecture and data flow

The web onboarding page reads the public build-time flag:

```text
NEXT_PUBLIC_ENABLE_SETUP_SKIP=true
```

No skip control is rendered unless the value is exactly `true`.

The client follows one of two existing API paths:

```text
No workspace:       POST /workspaces { name: "My workspace", onboardingStep: "done" }
Existing workspace: PATCH /workspaces/:id/onboarding { step: "done" }
```

On success, both paths navigate to the resulting workspace dashboard. The API already treats `done` as the explicit onboarding escape hatch, so this design does not add a second completion mechanism or weaken the social-connection gate for normal step progression.

## Component boundary

The behavior remains inside the onboarding wizard because it owns the current workspace identifier, loading state, error state, and completion navigation. A small pure configuration helper may be extracted if needed to make exact feature-flag behavior independently testable. No shared authentication or workspace-shell component is changed.

The skip action uses the shared `Button` primitive and existing onboarding layout tokens. It remains keyboard reachable, has visible focus through the shared primitive, and exposes its loading state in text.

## Error handling

- Clear any previous onboarding error before starting.
- Reject non-success API responses using the server message when available.
- Fall back to `Could not skip setup` when a response has no usable message.
- Restore the idle state in a `finally` block.
- Do not retry automatically, create multiple workspaces, or navigate after failure.

## Testing

- A web contract test verifies the skip control is absent by default and rendered only for the exact `true` flag.
- A testable helper or component contract verifies the two request shapes: create-and-complete without a workspace, and mark-done with an existing workspace.
- Existing workspace API tests continue to cover creation with an onboarding cursor and the `done` escape hatch.
- Run the focused web tests, workspace API tests, workspace typecheck, and production web build.
- Manually confirm the button appears on the isolated preview when the flag is enabled and reaches an empty workspace without completing intermediate setup steps.

## Operational use

For local preview:

```text
NEXT_PUBLIC_ENABLE_SETUP_SKIP=true
```

For staging, set the same variable only in staging environments where the bypass is intentionally allowed. Production deployments must omit it or set it to a value other than `true`.

## Non-goals

- Creating or managing admin credentials.
- Automatically signing in a user.
- Seeding demo content.
- Automatically skipping onboarding based only on `NODE_ENV`.
- Adding a production-visible skip path.
