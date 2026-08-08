# Local Setup Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly enabled local/staging onboarding action that creates or completes an empty workspace and opens its dashboard without running the remaining setup steps.

**Architecture:** Keep feature-flag parsing and request selection in a small pure web helper, then let the existing onboarding wizard execute that request through `apiFetch` and reuse its loading, error, and navigation state. The implementation consumes only the existing workspace creation and onboarding-cursor APIs; it does not add backend routes or modify authentication/admin infrastructure.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, shared Tuezday UI primitives, Vitest.

## Global Constraints

- Render the action only when `NEXT_PUBLIC_ENABLE_SETUP_SKIP=true` exactly.
- Create an empty workspace; do not seed campaigns, content, connections, Brain documents, or demo data.
- If a workspace already exists in the resumed wizard, mark its onboarding cursor `done` instead of creating another workspace.
- Do not modify login, authentication, session handling, admin credentials, `.env` files, environment loading, or dev-admin bootstrap code.
- Preserve normal production onboarding behavior when the public flag is absent or has any value other than `true`.
- Use existing shared `Button`, loading, error, and focus behavior.
- Use TDD and commit each completed task independently.

---

### Task 1: Define the setup-skip decision contract

**Files:**
- Create: `apps/web/lib/setup-skip.ts`
- Create: `apps/web/lib/setup-skip.test.ts`

**Interfaces:**
- Produces: `isSetupSkipEnabled(value: string | undefined): boolean`.
- Produces: `buildSetupSkipRequest(workspaceId: string | null): SetupSkipRequest`.
- `SetupSkipRequest` contains `path`, `method`, and a JSON-serializable `payload` for `apiFetch`.

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/lib/setup-skip.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify the missing module fails**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/setup-skip.test.ts
```

Expected: FAIL because `./setup-skip` does not exist.

- [ ] **Step 3: Add the minimal pure helper**

Create `apps/web/lib/setup-skip.ts`:

```ts
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
```

- [ ] **Step 4: Run the focused test and web typecheck**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/setup-skip.test.ts
npm run typecheck -w apps/web
```

Expected: 1 test file and 3 tests pass; web typecheck exits 0.

- [ ] **Step 5: Commit the helper contract**

```bash
git add apps/web/lib/setup-skip.ts apps/web/lib/setup-skip.test.ts
git commit -m "feat(web): define local setup skip contract"
```

---

### Task 2: Add the gated onboarding action

**Files:**
- Modify: `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/app/onboarding/onboarding.css`
- Create: `apps/web/lib/onboarding-setup-skip-contract.test.ts`

**Interfaces:**
- Consumes: `isSetupSkipEnabled` and `buildSetupSkipRequest` from `@/lib/setup-skip`.
- Preserves: the existing name, website, connection, verification, Brain, campaign, and draft onboarding paths.
- Produces: a flag-gated `Skip setup for now` button with loading, error, and success navigation behavior.

- [ ] **Step 1: Write the failing onboarding source contract**

Create `apps/web/lib/onboarding-setup-skip-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../app/onboarding/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/onboarding/onboarding.css", import.meta.url), "utf8");

describe("onboarding setup-skip source contract", () => {
  it("gates the secondary action behind the explicit public flag", () => {
    expect(page).toContain("NEXT_PUBLIC_ENABLE_SETUP_SKIP");
    expect(page).toContain("isSetupSkipEnabled");
    expect(page).toContain("Skip setup for now");
  });

  it("uses the canonical request builder and existing workspace navigation", () => {
    expect(page).toContain("buildSetupSkipRequest(workspaceId)");
    expect(page).toContain("const [skipping, setSkipping]");
    expect(page).toContain("Could not skip setup");
    expect(page).toContain("Skipping…");
    expect(page).toContain("router.push(`/workspaces/${targetId}`)");
    expect(css).toContain(".ob-skip");
  });
});
```

- [ ] **Step 2: Run the source contract and verify it fails**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/onboarding-setup-skip-contract.test.ts
```

Expected: FAIL because the onboarding page does not contain the setup-skip flag, action, or request builder.

- [ ] **Step 3: Import the helper and define the exact flag gate**

Add this import to `apps/web/app/onboarding/page.tsx`:

```ts
import { buildSetupSkipRequest, isSetupSkipEnabled } from "@/lib/setup-skip";
```

Add this constant after `STEP_LABELS`:

```ts
const SETUP_SKIP_ENABLED = isSetupSkipEnabled(
  process.env.NEXT_PUBLIC_ENABLE_SETUP_SKIP,
);
```

- [ ] **Step 4: Add the skip request handler**

Add this state beside the existing `busy` state inside `OnboardingWizard`:

```ts
  const [skipping, setSkipping] = useState(false);
```

Then add this function immediately after `createWorkspace`:

```ts
  async function skipSetup() {
    setSkipping(true);
    setError(null);
    try {
      const request = buildSetupSkipRequest(workspaceId);
      const res = await apiFetch(request.path, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? "Could not skip setup");
      }
      const targetId = workspaceId ?? body?.id;
      if (!targetId) throw new Error("Could not skip setup");
      router.push(`/workspaces/${targetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip setup");
    } finally {
      setSkipping(false);
    }
  }
```

- [ ] **Step 5: Render the shared secondary action throughout onboarding**

In `apps/web/app/onboarding/page.tsx`, immediately after the closing `</ol>` for `.ob-rail`, add:

```tsx
      {SETUP_SKIP_ENABLED && (
        <div className="ob-skip">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || skipping}
            onClick={skipSetup}
          >
            {skipping ? "Skipping…" : "Skip setup for now"}
          </Button>
        </div>
      )}
```

In `apps/web/app/onboarding/onboarding.css`, add after `.ob-rail`:

```css
.ob-skip {
  display: flex;
  justify-content: flex-end;
  margin: -12px 0 16px;
}
```

- [ ] **Step 6: Run focused onboarding and workspace tests**

Run:

```bash
npm exec --prefix apps/web vitest -- run lib/setup-skip.test.ts lib/onboarding-setup-skip-contract.test.ts
npm exec vitest -- run apps/api/test/workspaces.test.ts
```

Expected: 2 web files and 5 tests pass; the workspace API test file passes.

- [ ] **Step 7: Run typecheck and the production web build**

Run:

```bash
npm run typecheck
npm run build -w apps/web
```

Expected: all configured workspaces typecheck and the Next.js production build exits 0. The pre-existing multiple-lockfile workspace-root warning may still appear.

- [ ] **Step 8: Verify the isolated preview behavior**

Start the preview web process with the explicit flag and the isolated API:

```bash
NEXT_PUBLIC_ENABLE_SETUP_SKIP=true NEXT_PUBLIC_API_URL=http://localhost:3003 npm exec --prefix apps/web next -- dev -p 3002
```

Expected: after authenticating, `/onboarding` displays `Skip setup for now`; selecting it opens `/workspaces/[workspaceId]` without requiring website, social, Brain, campaign, or draft setup. The resulting workspace contains no seeded demo content.

- [ ] **Step 9: Commit the onboarding action**

```bash
git add apps/web/app/onboarding/page.tsx apps/web/app/onboarding/onboarding.css apps/web/lib/onboarding-setup-skip-contract.test.ts
git commit -m "feat(web): allow local setup bypass"
```
