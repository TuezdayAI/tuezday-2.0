# Instagram Direct Login Setup Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy Facebook Graph API Instagram setup hint with accurate direct Instagram Login instructions and prevent that copy regression.

**Architecture:** Keep the correction inside the existing `OAUTH_APP_HINTS` presentation map because no runtime connector behavior changes. Protect the operator contract with a focused Vitest source test that isolates the Instagram hint from the surrounding page.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest 3.

## Global Constraints

- The hint must name **Instagram API with Instagram Login**.
- The callback remains `http://localhost:3050/oauth/callback`.
- The scopes remain `instagram_business_basic` and `instagram_business_content_publish`.
- Credential names remain `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET`.
- The hint must not describe a Facebook Page dependency, Facebook Login, or the legacy Facebook Graph API flow.
- Do not change connector behavior, OAuth configuration, schemas, or other provider instructions.

---

### Task 1: Correct and protect the Instagram setup hint

**Files:**
- Create: `apps/web/lib/instagram-login-setup-copy.test.ts`
- Modify: `apps/web/app/workspaces/[id]/connectors/page.tsx:96-104`

**Interfaces:**
- Consumes: the existing `OAUTH_APP_HINTS.instagram` JSX entry.
- Produces: accurate operator-facing direct Instagram Login setup instructions; no exported runtime interface changes.

- [ ] **Step 1: Write the failing regression test**

Create `apps/web/lib/instagram-login-setup-copy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../app/workspaces/[id]/connectors/page.tsx", import.meta.url),
  "utf8",
);

const instagramHint = page.match(/instagram:\s*\([\s\S]*?\n\s*\),\n\s*gmail:/)?.[0];

describe("Instagram Login operator setup copy", () => {
  it("describes direct Instagram Login and rejects the legacy Facebook flow", () => {
    expect(instagramHint).toBeDefined();
    expect(instagramHint).toContain("Instagram API with Instagram Login");
    expect(instagramHint).toContain("instagram_business_basic");
    expect(instagramHint).toContain("instagram_business_content_publish");
    expect(instagramHint).toContain("INSTAGRAM_CLIENT_ID");
    expect(instagramHint).toContain("INSTAGRAM_CLIENT_SECRET");
    expect(instagramHint).not.toContain("Instagram Graph API");
    expect(instagramHint).not.toContain("Facebook Page");
    expect(instagramHint).not.toContain("Facebook Login");
    expect(instagramHint).not.toContain("Facebook app id/secret");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- apps/web/lib/instagram-login-setup-copy.test.ts
```

Expected: FAIL because the existing hint does not contain `Instagram API with Instagram Login` and still contains the legacy Facebook Graph API language.

- [ ] **Step 3: Apply the minimal copy correction**

Replace only the `instagram` JSX entry in `OAUTH_APP_HINTS` with:

```tsx
instagram: (
  <>
    Create a Meta developer app with “Instagram API with Instagram Login” for an Instagram
    Business/Creator account. Register callback uri{" "}
    <code>http://localhost:3050/oauth/callback</code>, request the{" "}
    <code>instagram_business_basic</code> and{" "}
    <code>instagram_business_content_publish</code> scopes, then set INSTAGRAM_CLIENT_ID and
    INSTAGRAM_CLIENT_SECRET in the root .env and restart the API.
  </>
),
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
npm test -- apps/web/lib/instagram-login-setup-copy.test.ts
npm run typecheck -w apps/web
git diff --check
```

Expected: the focused test passes, the web typecheck exits 0, and `git diff --check` produces no output.

- [ ] **Step 5: Commit the implementation**

```bash
git add apps/web/lib/instagram-login-setup-copy.test.ts \
  'apps/web/app/workspaces/[id]/connectors/page.tsx' \
  docs/superpowers/plans/2026-07-31-instagram-direct-login-setup-copy.md
git commit -m "fix(web): describe direct Instagram Login setup"
```

- [ ] **Step 6: Restart and verify the local acceptance server**

Stop the existing `npm run dev:app` process cleanly, then start it again from the Sprint 50 worktree with the existing gitignored development `.env` symlink.

Run:

```bash
npm run dev:app
curl --fail --silent --show-error http://127.0.0.1:3000/ -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:3001/health
```

Expected: the web root returns HTTP 200 and the health endpoint returns `{"status":"ok","db":"ok"}`.
