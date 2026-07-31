# Sprint 50 Provider Repair and Non-Destructive Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discovery use truthful, current provider capabilities, resolve
founder-entered account handles safely, and preserve surviving duplicate
occurrences when a source is deleted.

**Architecture:** Central provider configuration and typed provider-capability
errors feed both connected discovery and social adapters. Tracked account IDs
are resolved through one service and cached in the existing account row. Source
deletion delegates to a transaction-scoped dedupe service that promotes a
surviving occurrence and repairs legacy dangling groups without introducing
Sprint 60's canonical-story schema.

**Tech Stack:** TypeScript 5.7, Node.js 20+, Fastify 5, Drizzle ORM 0.44,
better-sqlite3 12, Zod 3.25, Vitest 3, Next.js 15, Nango connector fabric.

## Global Constraints

- Work only in branch `sprint-50-provider-repair-dedupe`, based on merged
  `origin/main` commit `1a657c7`.
- The approved design is
  `docs/superpowers/specs/2026-07-31-sprint-50-provider-repair-nondestructive-dedupe-design.md`
  at commit `a4820c3`.
- Use `LINKEDIN_API_VERSION` when it is exactly six digits; otherwise default
  to `202607`. Reject a configured non-six-digit value during app setup.
- Only `true`, `1`, `yes`, and `on`, case-insensitively and after trimming,
  enable `LINKEDIN_COMMUNITY_APPROVED`.
- The approval flag adds both `r_member_social` and
  `r_organization_social`; it remains an operator environment flag, not a
  founder-facing setting.
- LinkedIn plain handles and URLs support Company and School organization
  pages only. Never substitute the connected member from `/v2/userinfo` when
  organization resolution fails.
- `google_trends`, `g2`, `capterra`, and `intent` remain stored contract values
  but are reserved in the default product. Existing rows list as `reserved`;
  create/activation returns `source_reserved`; the scheduler never enqueues
  them.
- Instagram uses Nango provider `instagram`, base
  `https://graph.instagram.com`, and scopes
  `instagram_business_basic,instagram_business_content_publish`.
- Direct Instagram Login supports only the connected professional account's
  own media in discovery. Competitor targets return `unsupported_target`;
  hashtag mode returns `unsupported_mode`; legacy Facebook Login rows return
  `reconnect_required`.
- Threads is outside Sprint 50.
- Tracked-account resolution accepts a workspace-owned compatible connection.
  A failure preserves the last successful `externalId` and
  `lastResolvedAt`, while recording `lastError`.
- Changing a tracked handle clears `externalId`, `lastResolvedAt`, and
  `lastError`. Public create/update inputs never accept `externalId`.
- Source deletion promotes the oldest surviving duplicate, preserves that
  row's occurrence identity, copies the deleted canonical row's product state,
  moves matches, repoints the remaining duplicates, and deletes the source in
  one transaction.
- Startup repair of legacy dangling duplicate groups is deterministic,
  idempotent, and clears stale matching leases and errors.
- Stable provider/source codes are `source_reserved`, `target_unresolvable`,
  `permission_required`, `reconnect_required`, `unsupported_target`, and
  `unsupported_mode`.
- Do not add canonical-story or source-occurrence tables; that model remains
  Sprint 60 work.
- Every code change follows red-green TDD and receives a focused commit.
- Before starting a Plane child, read it and move only that child to
  `In Progress`. Move it to `Done` only after focused tests, relevant
  regressions, and `npm run typecheck` pass. Add a completion comment with
  behavior, commands/counts, and commit SHA.
- TAP-9 remains `In Progress` until TAP-51 through TAP-57 are `Done` and the
  full regression suite passes.

---

## File and Responsibility Map

### New API files

- `apps/api/src/connectors/provider-config.ts` — strict operator flag parsing,
  LinkedIn version validation, and shared LinkedIn REST headers.
- `apps/api/src/discovery/provider-errors.ts` — stable capability-error codes
  and the typed error consumed by discovery execution and routes.
- `apps/api/src/discovery/provider-account-resolvers.ts` — normalize and
  resolve LinkedIn organization and X user identities through an injected JSON
  request seam.
- `apps/api/src/services/tracked-account-resolver.ts` — authorize a compatible
  connection, resolve/cache provider IDs, and persist resolution failures.
- `apps/api/src/services/discovery-dedupe.ts` — transactional source deletion
  promotion and startup repair for dangling duplicate groups.

### New focused tests

- `apps/api/test/provider-config.test.ts`
- `apps/api/test/provider-account-resolvers.test.ts`
- `apps/api/test/sprint50-migrations.test.ts`
- `apps/api/test/discovery-dedupe.test.ts`
- `apps/api/test/tracked-account-resolver.test.ts`

### Existing files with concentrated changes

- `packages/contracts/src/index.ts` — reserved source status/set, direct
  Instagram provider contract, connection architecture marker, tracked
  resolution request schema, removal of public `externalId` writes, and
  activation comments.
- `apps/api/src/app.ts` — provider configuration fail-fast and one startup
  dangling-duplicate repair.
- `apps/api/src/services/connections.ts` and
  `apps/api/src/routes/connectors.ts` — strict LinkedIn scopes and direct
  Instagram identity binding at OAuth completion.
- `apps/api/src/discovery/connected-adapters.ts` — shared LinkedIn headers,
  explicit organization resolution, direct Instagram own-media reads, and no
  inline X fake-success behavior.
- `apps/api/src/connectors/social/linkedin.ts` — shared LinkedIn REST headers.
- `apps/api/src/connectors/social/index.ts` and
  `apps/api/src/connectors/social/instagram.ts` — pass the bound account ID and
  use direct Instagram Login for publishing, engagement, replies, and corpus
  reads.
- `apps/api/src/discovery/adapters.ts` — remove the dead Google Trends RSS
  request and keep all reserved values out of the live set.
- `apps/api/src/services/discovery.ts` — reserve-state validation, typed error
  persistence, asynchronous first-use resolution, and dedupe-safe deletion.
- `apps/api/src/services/discovery-jobs.ts` and
  `apps/api/src/services/discovery-scheduler.ts` — defense-in-depth exclusion
  of reserved sources.
- `apps/api/src/services/tracked-social-accounts.ts` and
  `apps/api/src/routes/discovery.ts` — server-owned resolution fields and the
  explicit retry route.
- `apps/web/app/workspaces/[id]/discovery/page.tsx` — reserved labels,
  Instagram limitations, resolution state, and retry action.
- `.env.example` and `docs/founder-acceptance-tests.md` — operator setup and
  founder walkthrough truth.

### Data-only migrations

- `apps/api/drizzle/0056_sprint_50_google_trends_reserved.sql` — park existing
  Google Trends sources and active jobs.
- `apps/api/drizzle/0057_sprint_50_instagram_login.sql` — mark legacy Instagram
  connections and affected sources as requiring reconnect.
- `apps/api/drizzle/0058_sprint_50_reserved_vocabulary.sql` — park existing G2,
  Capterra, and intent sources and active jobs.
- `apps/api/drizzle/meta/_journal.json` — register each migration in order.
- `apps/api/drizzle/meta/0056_snapshot.json`,
  `apps/api/drizzle/meta/0057_snapshot.json`, and
  `apps/api/drizzle/meta/0058_snapshot.json` — the unchanged 0055 schema body
  with a fresh `id`/`prevId` chain for each data-only migration.

---

### Task 1: TAP-51 — Centralize current LinkedIn version and approval scopes

**Files:**

- Create: `apps/api/src/connectors/provider-config.ts`
- Create: `apps/api/test/provider-config.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/services/connections.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/connectors/social/linkedin.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/test/connect-social.test.ts`
- Modify: `apps/api/test/social-read-linkedin.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces
  `operatorFlagEnabled(value: string | undefined): boolean`,
  `linkedinApiVersion(env?: NodeJS.ProcessEnv): string`,
  `linkedinRestHeaders(env?: NodeJS.ProcessEnv): Readonly<Record<string, string>>`,
  and `assertProviderConfiguration(env?: NodeJS.ProcessEnv): void`.
- Changes
  `resolveOAuthScopes(provider: ConnectorProvider, env?: NodeJS.ProcessEnv):
  string` so tests never mutate global process state to exercise parsing.
- Both LinkedIn adapters consume `linkedinRestHeaders`; no local
  `LinkedIn-Version` literal remains.

- [ ] **Step 1: Read TAP-51, move it to `In Progress`, and add the start comment**

The comment must name the approved design path, commit `a4820c3`, and this task's
red-green commands. Leave TAP-52 through TAP-57 unchanged.

- [ ] **Step 2: Write the failing provider configuration tests**

Create `apps/api/test/provider-config.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import {
  assertProviderConfiguration,
  linkedinApiVersion,
  linkedinRestHeaders,
  operatorFlagEnabled,
} from "../src/connectors/provider-config";
import { providerByKey, resolveOAuthScopes } from "../src/services/connections";

describe("provider configuration", () => {
  it("uses the July 2026 LinkedIn version by default", () => {
    expect(linkedinApiVersion({})).toBe("202607");
    expect(linkedinRestHeaders({})).toEqual({
      "LinkedIn-Version": "202607",
      "X-Restli-Protocol-Version": "2.0.0",
    });
  });

  it("accepts one six-digit operator override and rejects malformed values", () => {
    expect(linkedinApiVersion({ LINKEDIN_API_VERSION: " 202608 " })).toBe("202608");
    expect(() =>
      assertProviderConfiguration({ LINKEDIN_API_VERSION: "2026-08" }),
    ).toThrow(/LINKEDIN_API_VERSION must be exactly six digits/);
  });

  it.each(["true", "TRUE", " 1 ", "yes", "On"])(
    "treats %s as enabled",
    (value) => expect(operatorFlagEnabled(value)).toBe(true),
  );

  it.each([undefined, "", "false", "0", "no", "off", "anything"])(
    "treats %s as disabled",
    (value) => expect(operatorFlagEnabled(value)).toBe(false),
  );

  it("adds both approval-gated LinkedIn read scopes only when enabled", () => {
    const linkedin = providerByKey("linkedin")!;
    expect(resolveOAuthScopes(linkedin, {})).toBe(
      "openid,profile,email,w_member_social",
    );
    expect(
      resolveOAuthScopes(linkedin, {
        LINKEDIN_COMMUNITY_APPROVED: "true",
      }),
    ).toBe(
      "openid,profile,email,w_member_social,r_member_social,r_organization_social",
    );
    expect(
      resolveOAuthScopes(linkedin, {
        LINKEDIN_COMMUNITY_APPROVED: "false",
      }),
    ).toBe("openid,profile,email,w_member_social");
  });
});
```

Update the existing LinkedIn adapter assertions to require
`LinkedIn-Version: 202607`, and update the connect-social approved-scope case to
expect both restricted scopes.

- [ ] **Step 3: Run the focused tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/provider-config.test.ts apps/api/test/connect-social.test.ts apps/api/test/social-read-linkedin.test.ts
```

Expected: FAIL because `provider-config.ts` does not exist, the discovery
adapter sends `202506`, the social profile adapter sends `202411`, and only one
restricted scope is appended.

- [ ] **Step 4: Add strict provider configuration**

Create `apps/api/src/connectors/provider-config.ts`:

```ts
export const DEFAULT_LINKEDIN_API_VERSION = "202607";

const ENABLED_OPERATOR_VALUES = new Set(["true", "1", "yes", "on"]);

export function operatorFlagEnabled(value: string | undefined): boolean {
  return ENABLED_OPERATOR_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function linkedinApiVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.LINKEDIN_API_VERSION?.trim();
  if (!configured) return DEFAULT_LINKEDIN_API_VERSION;
  if (!/^\d{6}$/.test(configured)) {
    throw new Error(
      "LINKEDIN_API_VERSION must be exactly six digits in YYYYMM form.",
    );
  }
  return configured;
}

export function linkedinRestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  return {
    "LinkedIn-Version": linkedinApiVersion(env),
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

export function assertProviderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  linkedinApiVersion(env);
}
```

Call `assertProviderConfiguration()` at the beginning of `buildApp`, before
Fastify or any route is created.

- [ ] **Step 5: Use the shared policy in OAuth and both LinkedIn adapters**

Change `resolveOAuthScopes` to:

```ts
export function resolveOAuthScopes(
  provider: ConnectorProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = provider.oauthScopes ?? "";
  if (
    provider.key !== "linkedin" ||
    !operatorFlagEnabled(env.LINKEDIN_COMMUNITY_APPROVED)
  ) {
    return base;
  }
  return [
    ...base.split(",").filter(Boolean),
    "r_member_social",
    "r_organization_social",
  ].join(",");
}
```

Delete both local LinkedIn header literals. Pass
`headers: linkedinRestHeaders()` on every `/rest/` request in
`connected-adapters.ts` and `connectors/social/linkedin.ts`. Leave OpenID
`/v2/userinfo` publishing identity calls unversioned.

- [ ] **Step 6: Make the contract and operator documentation exact**

Keep LinkedIn's default contract scopes at:

```ts
oauthScopes: "openid,profile,email,w_member_social",
```

Replace the nearby comment so it names both `r_member_social` and
`r_organization_social`, the strict `LINKEDIN_COMMUNITY_APPROVED` operator
flag, and the reconnect requirement. Add to `.env.example`:

```dotenv
# Optional six-digit LinkedIn Marketing API version; defaults to 202607.
# LINKEDIN_API_VERSION=202607
# Enable only after LinkedIn approves Community Management access. Existing
# LinkedIn accounts must reconnect to grant the two added read scopes.
# LINKEDIN_COMMUNITY_APPROVED=false
```

- [ ] **Step 7: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/provider-config.test.ts apps/api/test/connect-social.test.ts apps/api/test/social-read-linkedin.test.ts apps/api/test/connected-discovery.test.ts
npm run typecheck
```

Expected: all selected test files pass and every workspace typecheck exits 0.

- [ ] **Step 8: Commit and finish TAP-51**

```bash
git add .env.example packages/contracts/src/index.ts apps/api/src/app.ts apps/api/src/connectors/provider-config.ts apps/api/src/connectors/social/linkedin.ts apps/api/src/discovery/connected-adapters.ts apps/api/src/services/connections.ts apps/api/test/provider-config.test.ts apps/api/test/connect-social.test.ts apps/api/test/social-read-linkedin.test.ts
git commit -m "fix: update LinkedIn API version and approved scopes"
```

Add the commit SHA and verification commands/counts to TAP-51, then move TAP-51
to `Done`.

---

### Task 2: TAP-52 — Resolve LinkedIn organization handles without self fallback

**Files:**

- Create: `apps/api/src/discovery/provider-errors.ts`
- Create: `apps/api/src/discovery/provider-account-resolvers.ts`
- Create: `apps/api/test/provider-account-resolvers.test.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`

**Interfaces:**

- Produces `ProviderCapabilityCode`, `ProviderCapabilityError`,
  `normalizeLinkedInOrganizationSlug(value: string): string | null`, and
  `resolveLinkedInOrganizationUrn(input:
  LinkedInOrganizationResolverInput): Promise<string>`.
- `LinkedInOrganizationResolverInput.get` has signature
  `(path: string) => Promise<{ status: number; json: unknown }>` so the
  connected adapter preserves call/byte budgets and the later tracked resolver
  reuses the same resolver.
- `safeExecutionFailure` consumes `ProviderCapabilityError` and exposes its
  stable code without provider response bodies.

- [ ] **Step 1: Read TAP-52 and move only it to `In Progress`**

Add a start comment naming company/school vanity resolution and the explicit
ban on `/v2/userinfo` fallback.

- [ ] **Step 2: Write failing resolver and integration tests**

Create `apps/api/test/provider-account-resolvers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  normalizeLinkedInOrganizationSlug,
  resolveLinkedInOrganizationUrn,
} from "../src/discovery/provider-account-resolvers";

describe("LinkedIn organization resolution", () => {
  it.each([
    ["@Acme", "acme"],
    ["acme", "acme"],
    ["https://www.linkedin.com/company/Acme/", "acme"],
    ["https://linkedin.com/school/Acme-University", "acme-university"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeLinkedInOrganizationSlug(value)).toBe(expected);
  });

  it("returns the exact vanity-name organization's URN", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      json: {
        elements: [
          { id: 42, vanityName: "other" },
          { id: 73, vanityName: "Acme" },
        ],
      },
    }));
    await expect(
      resolveLinkedInOrganizationUrn({ target: "@acme", get }),
    ).resolves.toBe("urn:li:organization:73");
    expect(get).toHaveBeenCalledWith(
      "/rest/organizations?q=vanityName&vanityName=acme",
    );
  });

  it("accepts a cached organization URN without a provider lookup", async () => {
    const get = vi.fn();
    await expect(
      resolveLinkedInOrganizationUrn({
        target: "urn:li:organization:73",
        get,
      }),
    ).resolves.toBe("urn:li:organization:73");
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed for a person URL or a missing exact organization", async () => {
    const get = vi.fn(async () => ({ status: 200, json: { elements: [] } }));
    await expect(
      resolveLinkedInOrganizationUrn({
        target: "https://linkedin.com/in/founder",
        get,
      }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
    await expect(
      resolveLinkedInOrganizationUrn({ target: "missing-company", get }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
  });

  it("fails closed for malformed organization results", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      json: { elements: [{ id: "not-numeric", vanityName: "acme" }] },
    }));
    await expect(
      resolveLinkedInOrganizationUrn({ target: "acme", get }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
  });
});
```

Add connected-discovery cases that assert a plain handle calls the
organization finder before `/rest/posts`, the posts request uses
`urn:li:organization:73`, and zero results produce
`target_unresolvable` with no `/v2/userinfo` or `/rest/posts` request.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/provider-account-resolvers.test.ts apps/api/test/connected-discovery.test.ts
```

Expected: FAIL because the resolver modules do not exist and the current
adapter falls back to the connected member's `/v2/userinfo`.

- [ ] **Step 4: Add stable capability errors**

Create `apps/api/src/discovery/provider-errors.ts`:

```ts
export const PROVIDER_CAPABILITY_CODES = [
  "source_reserved",
  "target_unresolvable",
  "permission_required",
  "reconnect_required",
  "unsupported_target",
  "unsupported_mode",
] as const;

export type ProviderCapabilityCode =
  (typeof PROVIDER_CAPABILITY_CODES)[number];

export class ProviderCapabilityError extends Error {
  constructor(
    public readonly code: ProviderCapabilityCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderCapabilityError";
  }
}
```

- [ ] **Step 5: Add the organization resolver**

Create `apps/api/src/discovery/provider-account-resolvers.ts`:

```ts
import { ProviderCapabilityError } from "./provider-errors";

interface LinkedInOrganization {
  id?: number | string;
  vanityName?: string;
}

interface LinkedInOrganizationsResponse {
  elements?: LinkedInOrganization[];
}

export interface LinkedInOrganizationResolverInput {
  target: string;
  get(path: string): Promise<{ status: number; json: unknown }>;
}

export function normalizeLinkedInOrganizationSlug(
  value: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^urn:li:organization:\d+$/.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const match = url.pathname.match(/^\/(?:company|school)\/([^/]+)\/?$/i);
    return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
  }
  const slug = trimmed.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : null;
}

export async function resolveLinkedInOrganizationUrn(
  input: LinkedInOrganizationResolverInput,
): Promise<string> {
  const slug = normalizeLinkedInOrganizationSlug(input.target);
  if (slug?.startsWith("urn:li:organization:")) return slug;
  if (!slug) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      "LinkedIn discovery supports Company and School page handles only.",
    );
  }
  const response = await input.get(
    `/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(slug)}`,
  );
  const payload = response.json as LinkedInOrganizationsResponse;
  const exact = (payload.elements ?? []).find(
    (organization) =>
      organization.vanityName?.trim().toLowerCase() === slug &&
      /^\d+$/.test(String(organization.id ?? "")),
  );
  if (!exact) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      `LinkedIn Company or School page "${slug}" could not be resolved.`,
    );
  }
  return `urn:li:organization:${String(exact.id)}`;
}
```

- [ ] **Step 6: Replace the discovery fallback and persist typed failures**

In `fetchLinkedInPage`, accept an existing organization URN or call
`resolveLinkedInOrganizationUrn` with the target handle/config handle and a
wrapper around `getJson`. The wrapper returns `{ status: 200, json }` because
`getJson` already translates non-success responses:

```ts
const explicitTarget =
  input.target.externalId?.trim() ||
  input.target.handle?.trim() ||
  config.handle?.trim() ||
  "";
const author = await resolveLinkedInOrganizationUrn({
  target: explicitTarget,
  async get(path) {
    return {
      status: 200,
      json: await getJson(input, path, {
        ...opts,
        cursorRequested: false,
      }),
    };
  },
});
```

Delete `LinkedInUserInfo` and every discovery call to `/v2/userinfo`. Add this
branch to `safeExecutionFailure` before the generic provider branch:

```ts
if (error instanceof ProviderCapabilityError) {
  return {
    code: error.code,
    persisted: `${error.code}: ${error.message}`.slice(0, 500),
  };
}
```

- [ ] **Step 7: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/provider-account-resolvers.test.ts apps/api/test/connected-discovery.test.ts
npm run typecheck
```

Expected: all selected tests pass, no discovery call log contains
`/v2/userinfo`, and typecheck exits 0.

- [ ] **Step 8: Commit and finish TAP-52**

```bash
git add apps/api/src/discovery/provider-errors.ts apps/api/src/discovery/provider-account-resolvers.ts apps/api/src/discovery/connected-adapters.ts apps/api/src/services/discovery.ts apps/api/test/provider-account-resolvers.test.ts apps/api/test/connected-discovery.test.ts
git commit -m "fix: resolve LinkedIn organizations without self fallback"
```

Comment with the SHA and test results, then move TAP-52 to `Done`.

---

### Task 3: TAP-53 — Reserve Google Trends and remove the dead RSS surface

**Files:**

- Create: `apps/api/drizzle/0056_sprint_50_google_trends_reserved.sql`
- Create: `apps/api/drizzle/meta/0056_snapshot.json`
- Create: `apps/api/test/sprint50-migrations.test.ts`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/discovery/adapters.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/services/discovery-jobs.ts`
- Modify: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `apps/api/test/adapters.test.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/discovery-bounds.test.ts`
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`

**Interfaces:**

- Adds `"reserved"` to `DISCOVERY_SOURCE_STATUSES`.
- Initially exports
  `RESERVED_DISCOVERY_SOURCE_TYPES = ["google_trends"] as const` and
  `isReservedDiscoverySourceType(type: DiscoverySourceType): boolean`; Task 7
  extends the same set without changing the function signature.
- Adds `DiscoverySourceReservedError` with code `source_reserved`.
- Existing Google Trends rows remain readable through the unchanged
  `DiscoverySource` response shape.

- [ ] **Step 1: Read TAP-53 and move only it to `In Progress`**

State in the Plane start comment that official Google Trends API alpha access is
not implemented and the dead RSS endpoint will be removed.

- [ ] **Step 2: Write the failing contract, scheduler, route, and migration tests**

Add these assertions to focused tests:

```ts
expect(DISCOVERY_SOURCE_STATUSES).toContain("reserved");
expect(isReservedDiscoverySourceType("google_trends")).toBe(true);
expect(isLiveSourceType("google_trends")).toBe(false);
```

The API test must POST a Google Trends source and expect:

```ts
expect(response.statusCode).toBe(409);
expect(response.json()).toMatchObject({ error: "source_reserved" });
```

Seed an existing reserved Trends row, PATCH it with `{ enabled: true }`, and
expect the same 409 response. A PATCH that only changes its display name must
remain allowed so legacy rows stay manageable.

The scheduler test must seed an enabled `google_trends` row with
`status = 'reserved'`, run one tick, and assert zero queued jobs. The migration
test must migrate a database through 0055, seed an active Trends source and
queued job, apply 0056, and assert:

```ts
expect(
  sqlite.prepare(
    "SELECT status, enabled, last_error FROM discovery_sources WHERE id = ?",
  ).get(sourceId),
).toEqual({
  status: "reserved",
  enabled: 0,
  last_error: "source_reserved",
});
expect(
  sqlite.prepare("SELECT status, error FROM discovery_jobs WHERE id = ?").get(jobId),
).toEqual({ status: "skipped", error: "source_reserved" });
```

Replace the adapter test that expects a
`trends.google.com/trendingsearches/daily/rss` request with one that asserts
`NeedsApiKeyError` and no safe-fetch calls.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/adapters.test.ts apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts
```

Expected: FAIL because `reserved` is not a status, Trends is live, creation
succeeds, the scheduler queues it, and migration 0056 is absent.

- [ ] **Step 4: Add the reserved source contract**

In `packages/contracts/src/index.ts`, add:

```ts
export const DISCOVERY_SOURCE_STATUSES = [
  "active",
  "needs_api_key",
  "reserved",
  "error",
] as const;

export const RESERVED_DISCOVERY_SOURCE_TYPES = [
  "google_trends",
] as const satisfies readonly DiscoverySourceType[];

const RESERVED_DISCOVERY_SOURCE_TYPE_SET = new Set<DiscoverySourceType>(
  RESERVED_DISCOVERY_SOURCE_TYPES,
);

export function isReservedDiscoverySourceType(
  type: DiscoverySourceType,
): boolean {
  return RESERVED_DISCOVERY_SOURCE_TYPE_SET.has(type);
}
```

Keep `google_trends` in `DISCOVERY_SOURCE_TYPES` for stored-data compatibility.

- [ ] **Step 5: Remove live fetching and reject creation/activation**

Delete `fetchGoogleTrends`, route `google_trends` through `NeedsApiKeyError`,
and remove it from `isLiveSourceType`.

Add this error in `services/discovery.ts`:

```ts
export class DiscoverySourceReservedError extends Error {
  readonly code = "source_reserved";

  constructor(type: DiscoverySourceType) {
    super(`${type} is reserved and has no production provider.`);
    this.name = "DiscoverySourceReservedError";
  }
}
```

At create, throw when the input type is reserved. At update, throw when a
reserved row is being activated with `enabled: true`. Make runtime derivation
return:

```ts
if (isReservedDiscoverySourceType(type)) {
  return {
    status: "reserved",
    lastError: "source_reserved",
    backoffUntil: null,
  };
}
```

Map `DiscoverySourceReservedError` in both source POST and PATCH routes to HTTP
409 with `{ error: "source_reserved", message: err.message }`.

- [ ] **Step 6: Exclude reserved rows at both scheduler boundaries**

The scheduler eligibility predicate must include
`source.status !== "reserved"`. `enqueueDueDiscoveryJobs` must also begin each
iteration with:

```ts
if (!source.enabled || source.status === "reserved") continue;
```

This prevents a direct service caller from bypassing the scheduler filter.

- [ ] **Step 7: Add and register migration 0056**

Create `apps/api/drizzle/0056_sprint_50_google_trends_reserved.sql`:

```sql
UPDATE discovery_jobs
SET
  status = 'skipped',
  finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  error = 'source_reserved',
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL
WHERE source_id IN (
  SELECT id FROM discovery_sources WHERE type = 'google_trends'
)
AND status IN ('queued', 'running');
--> statement-breakpoint
UPDATE discovery_sources
SET
  status = 'reserved',
  enabled = 0,
  last_error = 'source_reserved',
  backoff_until = NULL
WHERE type = 'google_trends';
```

Copy the 0055 schema body to 0056, then change only the snapshot chain header:

```json
{
  "version": "6",
  "dialect": "sqlite",
  "id": "8fd09c28-c98d-4aa4-bc4a-45158a5c2056",
  "prevId": "618ebbed-1590-48a0-a8f3-61dd7b46666e"
}
```

The `tables`, `enums`, `_meta`, and `internal` values remain byte-identical to
0055 because this migration has no schema DDL. Append journal entry:

```json
{
  "idx": 56,
  "version": "6",
  "when": 1785490200000,
  "tag": "0056_sprint_50_google_trends_reserved",
  "breakpoints": true
}
```

- [ ] **Step 8: Make the discovery UI honest**

Label the option `Google Trends — reserved`, disable its selectable add path,
remove its geo form, and render this explanatory copy:

```tsx
<p className="meta">
  Google Trends is reserved while the official API remains limited access.
</p>
```

Do not remove the type from label maps because existing rows still render.

- [ ] **Step 9: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/adapters.test.ts apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts
npm run typecheck
```

Expected: all selected tests pass, no test or production source contains the
removed Trends RSS URL, and typecheck exits 0.

- [ ] **Step 10: Commit and finish TAP-53**

```bash
git add packages/contracts/src/index.ts apps/api/drizzle/0056_sprint_50_google_trends_reserved.sql apps/api/drizzle/meta/0056_snapshot.json apps/api/drizzle/meta/_journal.json apps/api/src/discovery/adapters.ts apps/api/src/services/discovery.ts apps/api/src/services/discovery-jobs.ts apps/api/src/services/discovery-scheduler.ts apps/api/src/routes/discovery.ts apps/api/test/adapters.test.ts apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts 'apps/web/app/workspaces/[id]/discovery/page.tsx'
git commit -m "fix: reserve unsupported Google Trends discovery"
```

Comment with the SHA and verification evidence, then move TAP-53 to `Done`.

---

### Task 4: TAP-54 — Migrate Instagram to direct Instagram Login

**Files:**

- Create: `apps/api/drizzle/0057_sprint_50_instagram_login.sql`
- Create: `apps/api/drizzle/meta/0057_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/connections.ts`
- Modify: `apps/api/src/routes/connectors.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/connectors/social/index.ts`
- Modify: `apps/api/src/connectors/social/linkedin.ts`
- Modify: `apps/api/src/connectors/social/instagram.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/test/connect-social.test.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`
- Modify: `apps/api/test/connectors.test.ts`
- Modify: `apps/api/test/social-read-instagram.test.ts`
- Modify: `apps/api/test/launches.test.ts`
- Modify: `apps/api/test/carousels.test.ts`
- Modify: `apps/api/test/sprint50-migrations.test.ts`
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
- Modify: `.env.example`
- Modify: `docs/founder-acceptance-tests.md`

**Interfaces:**

- Extends `connectionSchema.config` with optional
  `authArchitecture: z.literal("instagram_login")`.
- Produces
  `bindInstagramOAuthIdentity(db: Db, fabric: ConnectorFabric, connection:
  Connection): Promise<Connection>`.
- Extends `SocialAdapterConfig` with
  `externalAccountId?: string | null` and
  `externalAccountHandle?: string | null`.
- Direct Instagram adapters use the persisted identity. They never call
  `/me/accounts`.

- [ ] **Step 1: Read TAP-54 and move only it to `In Progress`**

The Plane comment must state own-account media only, legacy reconnect required,
hashtag unsupported, competitor unsupported, and Threads excluded.

- [ ] **Step 2: Write failing registry, OAuth, adapter, migration, and capability tests**

Update the Instagram registry expectation to:

```ts
{
  key: "instagram",
  label: "Instagram",
  nangoProvider: "instagram",
  idEnv: "INSTAGRAM_CLIENT_ID",
  secretEnv: "INSTAGRAM_CLIENT_SECRET",
  scopes: "instagram_business_basic,instagram_business_content_publish",
}
```

For OAuth completion, make the fake fabric return:

```ts
{
  status: 200,
  json: {
    id: "ig-direct-42",
    user_id: "ig-direct-42",
    username: "tuezday",
    name: "Tuezday",
    account_type: "BUSINESS",
  },
}
```

Assert the stored connection has `externalAccountId = "ig-direct-42"`,
`externalAccountHandle = "tuezday"`, and
`config.authArchitecture = "instagram_login"`.

Rewrite Instagram social and discovery fixtures to assert base
`https://graph.instagram.com`, no `/me/accounts`, and own-media path
`/ig-direct-42/media`. Add discovery assertions:

```ts
expect(hashtagRun.sources[0]!.error).toContain("unsupported_mode");
expect(competitorRun.sources[0]!.error).toContain("unsupported_target");
expect(ownAccountRun.sources[0]!.error).toBeUndefined();
```

Extend the migration test so a legacy Instagram connection and its source
become `reconnect_required`.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/connect-social.test.ts apps/api/test/connectors.test.ts apps/api/test/social-read-instagram.test.ts apps/api/test/connected-discovery.test.ts apps/api/test/launches.test.ts apps/api/test/carousels.test.ts apps/api/test/sprint50-migrations.test.ts
```

Expected: FAIL because the registry still provisions Facebook Login, OAuth
does not bind identity, adapters call Facebook Page discovery, and migration
0057 is absent.

- [ ] **Step 4: Change the public provider and connection contract**

Use this provider entry:

```ts
{
  key: "instagram",
  label: "Instagram",
  nangoProvider: "instagram",
  authMode: "oauth",
  categories: ["social"],
  baseUrl: "https://graph.instagram.com",
  testPath: "/me?fields=id,user_id,username,name,account_type",
  oauthScopes:
    "instagram_business_basic,instagram_business_content_publish",
},
```

Extend connection config with:

```ts
authArchitecture: z.literal("instagram_login").optional(),
```

Update environment comments so the same variable names now refer to Instagram
app credentials for direct Instagram Login, not a Facebook app or linked Page.

- [ ] **Step 5: Bind the direct account at OAuth completion**

Add to `services/connections.ts`:

```ts
interface InstagramIdentity {
  id?: string;
  user_id?: string;
  username?: string;
  name?: string;
}

export async function bindInstagramOAuthIdentity(
  db: Db,
  fabric: ConnectorFabric,
  connection: Connection,
): Promise<Connection> {
  const response = await fabric.proxyJson(
    "GET",
    "/me?fields=id,user_id,username,name,account_type",
    connection.nangoConnectionId,
    integrationKeyFor(providerByKey("instagram")!),
    { baseUrlOverride: "https://graph.instagram.com" },
  );
  const identity = response.json as InstagramIdentity;
  const accountId = identity.user_id?.trim() || identity.id?.trim();
  const username = identity.username?.trim().replace(/^@+/, "");
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !accountId ||
    !username
  ) {
    db.update(connections)
      .set({
        status: "error",
        lastError: "reconnect_required",
        lastCheckedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(connections.workspaceId, connection.workspaceId),
          eq(connections.id, connection.id),
        ),
      )
      .run();
    throw new ProviderCapabilityError(
      "reconnect_required",
      "Instagram Login did not return a professional account identity.",
    );
  }
  const now = Date.now();
  db.update(connections)
    .set({
      configJson: JSON.stringify({
        ...connection.config,
        authArchitecture: "instagram_login",
      }),
      displayName: identity.name?.trim() || `@${username}`,
      externalAccountId: accountId,
      externalAccountName: identity.name?.trim() || username,
      externalAccountHandle: username.toLowerCase(),
      externalAccountUrl: `https://www.instagram.com/${username}/`,
      status: "connected",
      lastCheckedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(connections.workspaceId, connection.workspaceId),
        eq(connections.id, connection.id),
      ),
    )
    .run();
  return getConnection(db, connection.workspaceId, connection.id)!;
}
```

In OAuth completion, call this immediately after registration when
`provider.key === "instagram"`, then test and return the bound connection.
Translate `ProviderCapabilityError` to HTTP 409 with its stable code.

- [ ] **Step 6: Move the social adapter to the persisted direct identity**

Pass `connection.externalAccountId` and `connection.externalAccountHandle`
through `socialAdapterFor`. In `InstagramAdapter`, set:

```ts
const GRAPH = "https://graph.instagram.com";

private igUserId(): string {
  const accountId = this.config.externalAccountId?.trim();
  if (!accountId) {
    throw new ProviderCapabilityError(
      "reconnect_required",
      "Reconnect Instagram with direct Instagram Login.",
    );
  }
  return accountId;
}
```

Delete `AccountsResponse` and the asynchronous Page lookup. Use versionless
direct paths consistently:

```ts
`/${igId}/media`
`/${igId}/media_publish`
`/${mediaId}?fields=permalink`
`/${post.externalId}?fields=like_count,comments_count`
`/${post.externalId}/comments?fields=id,text,username,timestamp`
`/${input.parentExternalId}/replies`
`/${igId}?fields=username,name,biography`
`/${igId}/media?fields=caption,permalink,timestamp&limit=25`
```

Keep the existing bounded video polling and carousel construction unchanged
apart from the base host, versionless paths, and synchronous account ID.

- [ ] **Step 7: Restrict connected discovery to the own account**

At the beginning of `fetchInstagramPage`, enforce:

```ts
if (input.connection.config.authArchitecture !== "instagram_login") {
  throw new ProviderCapabilityError(
    "reconnect_required",
    "Reconnect Instagram with direct Instagram Login.",
  );
}
if (config.mode === "hashtag") {
  throw new ProviderCapabilityError(
    "unsupported_mode",
    "Instagram Login does not support hashtag discovery.",
  );
}
if (config.mode !== "account_timeline") {
  throw new ProviderCapabilityError(
    "unsupported_mode",
    `Instagram sources do not support mode "${String(config.mode)}".`,
  );
}
const requested = input.target.handle?.trim().replace(/^@+/, "").toLowerCase();
const connected = input.connection.externalAccountHandle
  ?.trim()
  .replace(/^@+/, "")
  .toLowerCase();
const accountId = input.connection.externalAccountId?.trim();
if (!connected || !accountId) {
  throw new ProviderCapabilityError(
    "reconnect_required",
    "Reconnect Instagram to bind its professional account.",
  );
}
if (requested !== connected) {
  throw new ProviderCapabilityError(
    "unsupported_target",
    "Instagram Login can read only the connected account's own media.",
  );
}
```

Read own media from:

```ts
let path =
  `/${accountId}/media` +
  `?fields=id,caption,permalink,timestamp,like_count,comments_count` +
  `&limit=${limit}`;
path = appendQuery(path, "after", token);
```

Remove Business Discovery, hashtag search, and Page lookup types and requests.

- [ ] **Step 8: Add and register migration 0057**

Create `apps/api/drizzle/0057_sprint_50_instagram_login.sql`:

```sql
UPDATE connections
SET
  status = 'error',
  last_error = 'reconnect_required',
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE provider_key = 'instagram'
AND COALESCE(json_extract(config_json, '$.authArchitecture'), '') <> 'instagram_login';
--> statement-breakpoint
UPDATE discovery_sources
SET
  status = 'error',
  last_error = 'reconnect_required',
  backoff_until = NULL
WHERE connection_id IN (
  SELECT id
  FROM connections
  WHERE provider_key = 'instagram'
  AND last_error = 'reconnect_required'
);
--> statement-breakpoint
UPDATE discovery_jobs
SET
  status = 'skipped',
  finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  error = 'reconnect_required',
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL
WHERE source_id IN (
  SELECT id FROM discovery_sources WHERE last_error = 'reconnect_required'
)
AND status IN ('queued', 'running');
```

Copy the 0056 schema body to 0057, then set the snapshot chain header to:

```json
{
  "version": "6",
  "dialect": "sqlite",
  "id": "5ae86b8b-24b8-47d0-9965-686438c57657",
  "prevId": "8fd09c28-c98d-4aa4-bc4a-45158a5c2056"
}
```

Append:

```json
{
  "idx": 57,
  "version": "6",
  "when": 1785490800000,
  "tag": "0057_sprint_50_instagram_login",
  "breakpoints": true
}
```

- [ ] **Step 9: Update UI and founder/operator copy**

Remove Instagram hashtag selection. Explain that direct Instagram Login reads
only the connected account. When an existing source is unsupported or its
connection is legacy, render its stable error and reconnect guidance. Replace
all Facebook app, Page-linking, `instagram_basic`, and `/v23.0/me` instructions
in `.env.example` and founder acceptance docs with the direct provider, two
scopes, identity binding, own-account limit, and reconnect step.

- [ ] **Step 10: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/connect-social.test.ts apps/api/test/connectors.test.ts apps/api/test/social-read-instagram.test.ts apps/api/test/connected-discovery.test.ts apps/api/test/launches.test.ts apps/api/test/carousels.test.ts apps/api/test/sprint50-migrations.test.ts
npm run typecheck
```

Expected: all selected tests pass; `rg` finds no Facebook Login path or Page
lookup in Instagram production code; typecheck exits 0.

- [ ] **Step 11: Commit and finish TAP-54**

```bash
git add .env.example docs/founder-acceptance-tests.md packages/contracts/src/index.ts apps/api/drizzle/0057_sprint_50_instagram_login.sql apps/api/drizzle/meta/0057_snapshot.json apps/api/drizzle/meta/_journal.json apps/api/src/services/connections.ts apps/api/src/routes/connectors.ts apps/api/src/discovery/connected-adapters.ts apps/api/src/connectors/social/index.ts apps/api/src/connectors/social/linkedin.ts apps/api/src/connectors/social/instagram.ts apps/api/src/services/discovery.ts apps/api/test/connect-social.test.ts apps/api/test/connected-discovery.test.ts apps/api/test/connectors.test.ts apps/api/test/social-read-instagram.test.ts apps/api/test/launches.test.ts apps/api/test/carousels.test.ts apps/api/test/sprint50-migrations.test.ts 'apps/web/app/workspaces/[id]/discovery/page.tsx'
git commit -m "fix: migrate Instagram to direct login"
```

Comment with the SHA and verification evidence, then move TAP-54 to `Done`.

---

### Task 5: TAP-55 — Promote duplicates transactionally on source deletion

**Files:**

- Create: `apps/api/src/services/discovery-dedupe.ts`
- Create: `apps/api/test/discovery-dedupe.test.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/discovery.test.ts`

**Interfaces:**

- Produces
  `deleteDiscoverySourcePreservingDuplicates(db: Db, workspaceId: string,
  sourceId: string, hooks?: DiscoveryDedupeHooks): boolean`,
  `DiscoveryDedupeHooks = { beforeSourceDelete?(): void }`, and
  `repairDanglingDuplicateGroups(db: Db): { groups: number; promoted: number;
  repointed: number }`.
- `services/discovery.ts` keeps its public
  `deleteDiscoverySource(db, workspaceId, sourceId): boolean` signature and
  delegates to the new service, so routes do not change.
- Promotion preserves the survivor's `id`, `workspaceId`, `sourceId`,
  `externalId`, `urlHash`, `contentHash`, and `createdAt`. It copies the
  canonical's founder-visible story/scoring state, including the canonical
  `publishedAt` as specified by the approved product-state list.

- [ ] **Step 1: Read TAP-55 and move only it to `In Progress`**

Add a Plane comment stating that the implementation is the approved
transactional promotion, not the Sprint 60 schema rewrite.

- [ ] **Step 2: Write failing promotion, rollback, and repair tests**

Create `apps/api/test/discovery-dedupe.test.ts` with fixtures for:

1. A canonical row on source A, two duplicates on sources B/C, and two
   `discovered_item_matches`.
2. Deleting A promotes the oldest B row, keeps B's occurrence ID/source/external
   ID/hashes/createdAt, copies A's title/URL/summary/publishedAt/score/reason/
   suggestion/status/signal/scoring state, moves matches to B, and points C at
   B.
3. A hook-thrown exception before source deletion rolls back every promotion,
   match move, repoint, and source delete.
4. A legacy group whose `duplicateOfId` names a missing row is repaired by
   promoting its oldest occurrence to `new`/`pending`, repointing the rest,
   clearing leases/errors, and returning counts.
5. A second repair run returns zero counts and changes no rows.
6. Deleting a source that owns only a duplicate leaves its canonical group
   untouched.
7. Deleting a source whose canonical item has no surviving occurrence removes
   that item normally.

The central assertions are:

```ts
expect(promoted).toMatchObject({
  id: oldestSurvivorId,
  sourceId: survivingSourceId,
  externalId: "survivor-provider-id",
  title: "Canonical title",
  status: "accepted",
  signalId,
  duplicateOfId: null,
  matchingState: "frozen",
});
expect(
  db.select().from(discoveredItemMatches).all().map((row) => row.itemId),
).toEqual([oldestSurvivorId, oldestSurvivorId]);
expect(remainingDuplicate.duplicateOfId).toBe(oldestSurvivorId);
expect(repairDanglingDuplicateGroups(db)).toEqual({
  groups: 0,
  promoted: 0,
  repointed: 0,
});
```

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/discovery-dedupe.test.ts apps/api/test/discovery.test.ts
```

Expected: FAIL because deleting source A cascades its canonical row and leaves
survivors pointing at a missing ID; no repair function exists.

- [ ] **Step 4: Implement one transaction-scoped promotion helper**

In `discovery-dedupe.ts`, import `DbExecutor` from `../db`, define the rollback
test seam, and use one private helper:

```ts
export interface DiscoveryDedupeHooks {
  beforeSourceDelete?(): void;
}

function promoteCanonicalBeforeDelete(
  tx: DbExecutor,
  canonical: DiscoveredItemRow,
  survivor: DiscoveredItemRow,
): number {
  tx.delete(discoveredItemMatches)
    .where(eq(discoveredItemMatches.itemId, survivor.id))
    .run();
  tx.update(discoveredItemMatches)
    .set({ itemId: survivor.id })
    .where(eq(discoveredItemMatches.itemId, canonical.id))
    .run();
  tx.update(discoveredItems)
    .set({
      title: canonical.title,
      url: canonical.url,
      summary: canonical.summary,
      publishedAt: canonical.publishedAt,
      score: canonical.score,
      suggestedPersonaId: canonical.suggestedPersonaId,
      suggestedCampaignId: canonical.suggestedCampaignId,
      scoreReason: canonical.scoreReason,
      status: canonical.status,
      signalId: canonical.signalId,
      scoredAt: canonical.scoredAt,
      matchingState: canonical.matchingState,
      matchingVersion: canonical.matchingVersion,
      matchingInputFingerprint: canonical.matchingInputFingerprint,
      matchingError: canonical.matchingError,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      duplicateOfId: null,
    })
    .where(eq(discoveredItems.id, survivor.id))
    .run();
  return tx.update(discoveredItems)
    .set({
      duplicateOfId: survivor.id,
      status: "duplicate",
      matchingState: "frozen",
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
    })
    .where(
      and(
        eq(discoveredItems.duplicateOfId, canonical.id),
        ne(discoveredItems.id, survivor.id),
      ),
    )
    .run().changes;
}

export function deleteDiscoverySourcePreservingDuplicates(
  db: Db,
  workspaceId: string,
  sourceId: string,
  hooks: DiscoveryDedupeHooks = {},
): boolean {
  return db.transaction((tx) => {
    const source = tx.select({ id: discoverySources.id })
      .from(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.id, sourceId),
        ),
      )
      .get();
    if (!source) return false;

    const canonicals = tx.select()
      .from(discoveredItems)
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.sourceId, sourceId),
          isNull(discoveredItems.duplicateOfId),
        ),
      )
      .all();
    for (const canonical of canonicals) {
      const survivor = tx.select()
        .from(discoveredItems)
        .where(
          and(
            eq(discoveredItems.workspaceId, workspaceId),
            eq(discoveredItems.duplicateOfId, canonical.id),
            ne(discoveredItems.sourceId, sourceId),
          ),
        )
        .orderBy(asc(discoveredItems.createdAt), asc(discoveredItems.id))
        .limit(1)
        .get();
      if (survivor) {
        promoteCanonicalBeforeDelete(tx, canonical, survivor);
      }
    }

    hooks.beforeSourceDelete?.();
    return tx.delete(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.id, sourceId),
        ),
      )
      .run().changes === 1;
  });
}
```

The survivor ordering is `createdAt ASC, id ASC`. Query canonicals owned by the
source, promote only when a duplicate on another source survives, then delete
the source before the transaction returns `true`. Invoke
`hooks.beforeSourceDelete?.()` immediately before the source delete so the
rollback test can throw after every promotion/repoint write.

- [ ] **Step 5: Implement deterministic legacy repair**

Group all rows with non-null `duplicateOfId` whose referenced canonical ID is
absent in the same workspace. Use the pair `[workspaceId, duplicateOfId]` as
the group key. For each missing ID, sort by `createdAt` then `id`, promote the
first, delete group matches, and repair the complete group transactionally:

```ts
export function repairDanglingDuplicateGroups(
  db: Db,
): { groups: number; promoted: number; repointed: number } {
  return db.transaction((tx) => {
    const rows = tx.select().from(discoveredItems).all();
    const existing = new Set(
      rows.map((row) => JSON.stringify([row.workspaceId, row.id])),
    );
    const dangling = new Map<string, DiscoveredItemRow[]>();
    for (const row of rows) {
      if (!row.duplicateOfId) continue;
      const canonicalKey = JSON.stringify([
        row.workspaceId,
        row.duplicateOfId,
      ]);
      if (existing.has(canonicalKey)) continue;
      const members = dangling.get(canonicalKey) ?? [];
      members.push(row);
      dangling.set(canonicalKey, members);
    }

    let promoted = 0;
    let repointed = 0;
    for (const members of dangling.values()) {
      members.sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
      const survivor = members[0]!;
      const ids = members.map((row) => row.id);
      tx.delete(discoveredItemMatches)
        .where(
          and(
            eq(discoveredItemMatches.workspaceId, survivor.workspaceId),
            inArray(discoveredItemMatches.itemId, ids),
          ),
        )
        .run();
      tx.update(discoveredItems)
        .set({
          score: null,
          suggestedPersonaId: null,
          suggestedCampaignId: null,
          scoreReason: null,
          status: "new",
          signalId: null,
          scoredAt: null,
          matchingState: "pending",
          matchingVersion: sql`${discoveredItems.matchingVersion} + 1`,
          matchingInputFingerprint: null,
          matchingLeaseOwner: null,
          matchingLeaseExpiresAt: null,
          matchingHeartbeatAt: null,
          matchingError: null,
          duplicateOfId: null,
        })
        .where(eq(discoveredItems.id, survivor.id))
        .run();
      promoted += 1;

      const remainingIds = ids.slice(1);
      if (remainingIds.length > 0) {
        repointed += tx.update(discoveredItems)
          .set({
            status: "duplicate",
            matchingState: "frozen",
            matchingLeaseOwner: null,
            matchingLeaseExpiresAt: null,
            matchingHeartbeatAt: null,
            matchingError: null,
            duplicateOfId: survivor.id,
          })
          .where(inArray(discoveredItems.id, remainingIds))
          .run().changes;
      }
    }
    return {
      groups: dangling.size,
      promoted,
      repointed,
    };
  });
}
```

This leaves every non-promoted row `duplicate`/`frozen` with null
leases/errors and returns exact group, promotion, and repoint counts.

- [ ] **Step 6: Wire deletion and startup repair**

Make `deleteDiscoverySource` delegate directly:

```ts
export function deleteDiscoverySource(
  db: Db,
  workspaceId: string,
  sourceId: string,
): boolean {
  return deleteDiscoverySourcePreservingDuplicates(
    db,
    workspaceId,
    sourceId,
  );
}
```

Call `repairDanglingDuplicateGroups(db)` in `buildApp` after existing local
backfills and before routes are registered. Do not log row contents; tests can
assert the returned counts by calling the service directly.

- [ ] **Step 7: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/discovery-dedupe.test.ts apps/api/test/discovery.test.ts
npm run typecheck
```

Expected: all selected tests pass, the rollback fixture remains unchanged, the
repair rerun is a no-op, and typecheck exits 0.

- [ ] **Step 8: Commit and finish TAP-55**

```bash
git add apps/api/src/services/discovery-dedupe.ts apps/api/src/services/discovery.ts apps/api/src/app.ts apps/api/test/discovery-dedupe.test.ts apps/api/test/discovery.test.ts
git commit -m "fix: preserve duplicates when deleting discovery sources"
```

Comment with SHA and evidence, then move TAP-55 to `Done`.

---

### Task 6: TAP-56 — Resolve and cache tracked-account provider IDs

**Files:**

- Create: `apps/api/src/services/tracked-account-resolver.ts`
- Create: `apps/api/test/tracked-account-resolver.test.ts`
- Modify: `apps/api/src/discovery/provider-account-resolvers.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/services/tracked-social-accounts.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`

**Interfaces:**

- Adds `resolveTrackedSocialAccountInputSchema` with required UUID
  `connectionId`.
- Produces
  `resolveXUserId(input: XUserResolverInput): Promise<string>`,
  `resolveTrackedSocialAccount(deps: TrackedAccountResolverDependencies,
  input: { workspaceId: string; accountId: string; connectionId: string;
  force?: boolean; runtime?: TrackedResolutionRuntime }):
  Promise<TrackedSocialAccount>`, and
  `resolveTrackedAccountsForSource(deps: TrackedAccountResolverDependencies,
  input: { source: DiscoverySource; accounts: TrackedSocialAccount[];
  connectionId: string; runtime: TrackedResolutionRuntime }):
  Promise<TrackedSocialAccount[]>`, where
  `TrackedAccountResolverDependencies` is
  `{ db: Db; fabric: ConnectorFabric }` and `TrackedResolutionRuntime` carries
  the shared Sprint 49 abort/call/byte budget and mutable metrics.
- The service maps platforms to provider keys exactly:
  `x -> twitter`, `linkedin -> linkedin`, `instagram -> instagram`,
  `reddit -> reddit`.

- [ ] **Step 1: Read TAP-56 and move only it to `In Progress`**

The Plane start comment must state that provider IDs become server-owned, are
resolved on first source use, and remain manually retryable.

- [ ] **Step 2: Write failing resolver, public-input, route, and first-use tests**

Create `apps/api/test/tracked-account-resolver.test.ts` with these behaviors:

- X calls `/2/users/by/username/acme`, persists `"x-user-42"`, sets
  `lastResolvedAt`, and clears `lastError`.
- LinkedIn reuses the exact vanity resolver and persists
  `urn:li:organization:73`.
- Reddit performs no network call and stores its normalized handle as the
  durable ID.
- Instagram resolves only when its handle matches the selected connection's
  bound handle; a competitor returns `unsupported_target`.
- A foreign-workspace, missing, disconnected, or wrong-provider connection is
  rejected with the same non-leaking connection error.
- A failed forced retry retains the prior `externalId` and
  `lastResolvedAt`, updates only `lastError`, and throws the stable error.
- A successful forced retry replaces the cached ID.

Add contract tests:

```ts
expect(
  createTrackedSocialAccountInputSchema.parse({
    platform: "x",
    handle: "@acme",
    externalId: "founder-supplied",
  }),
).not.toHaveProperty("externalId");
expect(
  updateTrackedSocialAccountInputSchema.parse({
    externalId: "founder-supplied",
  }),
).not.toHaveProperty("externalId");
```

Add API coverage for:

```ts
POST /workspaces/:id/discovery/tracked-accounts/:accountId/resolve
{ "connectionId": "11111111-1111-4111-8111-111111111111" }
```

and a discovery-run test proving a missing cached LinkedIn/X ID is resolved and
persisted before the provider timeline call.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/tracked-account-resolver.test.ts apps/api/test/connected-discovery.test.ts
```

Expected: FAIL because the resolver service/route do not exist, public inputs
accept `externalId`, and first use does not persist the inline lookup.

- [ ] **Step 4: Add the X resolver beside the LinkedIn resolver**

Add to `provider-account-resolvers.ts`:

```ts
interface XUserResponse {
  data?: { id?: string; username?: string };
}

export interface XUserResolverInput {
  handle: string;
  get(path: string): Promise<{ status: number; json: unknown }>;
}

export async function resolveXUserId(
  input: XUserResolverInput,
): Promise<string> {
  const handle = input.handle.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      "The X username is invalid.",
    );
  }
  const response = await input.get(
    `/2/users/by/username/${encodeURIComponent(handle)}`,
  );
  const id = (response.json as XUserResponse).data?.id?.trim();
  if (!id) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      `X account "@${handle}" could not be resolved.`,
    );
  }
  return id;
}
```

Use it in `fetchXPage`; remove the current empty-result branch for unresolved
users.

- [ ] **Step 5: Make resolution fields server-owned and clear cache on handle change**

Remove `externalId` from both public Zod input schemas. In create, always write
`externalId: null`. In update:

```ts
const handleChanged = handle !== existing.handle;
const executionChanged =
  handleChanged || nextEnabled !== existing.enabled;

tx.update(trackedSocialAccounts)
  .set({
    handle,
    displayName:
      input.displayName === undefined ? existing.displayName : input.displayName,
    externalId: handleChanged ? null : existing.externalId,
    lastResolvedAt: handleChanged ? null : existing.lastResolvedAt,
    lastError: handleChanged ? null : existing.lastError,
    url: input.url === undefined ? existing.url : input.url,
    notes: input.notes ?? existing.notes,
    enabled: nextEnabled,
    updatedAt: Date.now(),
  })
```

Keep source invalidation when the handle or enabled state changes.

- [ ] **Step 6: Implement the authorized cache service**

In `tracked-account-resolver.ts`, load the workspace account and connection,
validate ownership/status/provider, and resolve through the connector fabric.
Use one persistence boundary:

```ts
function persistResolutionSuccess(
  db: Db,
  account: TrackedSocialAccount,
  externalId: string,
): TrackedSocialAccount {
  const now = Date.now();
  db.update(trackedSocialAccounts)
    .set({
      externalId,
      lastResolvedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, account.workspaceId),
        eq(trackedSocialAccounts.id, account.id),
      ),
    )
    .run();
  return getTrackedSocialAccount(db, account.workspaceId, account.id)!;
}

function persistResolutionFailure(
  db: Db,
  account: TrackedSocialAccount,
  error: ProviderCapabilityError,
): void {
  db.update(trackedSocialAccounts)
    .set({
      lastError: `${error.code}: ${error.message}`.slice(0, 500),
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, account.workspaceId),
        eq(trackedSocialAccounts.id, account.id),
      ),
    )
    .run();
}
```

Define and enforce the inherited Sprint 49 budget on first-use provider calls:

```ts
export interface TrackedResolutionRuntime {
  signal?: AbortSignal;
  maxCalls?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
  metrics: { calls: number; bytes: number };
}

const PLATFORM_PROVIDER = {
  x: "twitter",
  linkedin: "linkedin",
  instagram: "instagram",
  reddit: "reddit",
} as const;

const PROVIDER_BASE_URL = {
  twitter: "https://api.twitter.com",
  linkedin: "https://api.linkedin.com",
} as const;

export class TrackedAccountConnectionError extends Error {
  readonly code = "connection_unavailable";

  constructor() {
    super("A compatible connected account is unavailable.");
    this.name = "TrackedAccountConnectionError";
  }
}

export class TrackedAccountNotFoundError extends Error {
  constructor() {
    super("Tracked account not found.");
    this.name = "TrackedAccountNotFoundError";
  }
}

async function providerGet(
  deps: TrackedAccountResolverDependencies,
  connection: Connection,
  path: string,
  baseUrl: string,
  runtime?: TrackedResolutionRuntime,
): Promise<{ status: number; json: unknown }> {
  if (
    runtime?.maxCalls !== undefined &&
    runtime.metrics.calls >= runtime.maxCalls
  ) {
    throw new ConnectedDiscoveryBudgetError("call_budget_exhausted");
  }
  if (runtime) runtime.metrics.calls += 1;
  const response = await deps.fabric.proxyJson(
    "GET",
    path,
    connection.nangoConnectionId,
    `tuezday-${connection.providerKey}`,
    {
      baseUrlOverride: baseUrl,
      headers:
        connection.providerKey === "linkedin"
          ? linkedinRestHeaders()
          : undefined,
      signal: runtime?.signal,
      maxResponseBytes: runtime?.maxResponseBytes,
    },
  );
  if (runtime) {
    runtime.metrics.bytes += response.decodedBytes ?? 0;
    if (
      runtime.maxBytes !== undefined &&
      runtime.metrics.bytes > runtime.maxBytes
    ) {
      throw new ConnectedDiscoveryBudgetError(
        "source_byte_budget_exhausted",
      );
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderCapabilityError(
      "permission_required",
      "The selected connection lacks permission to resolve this account.",
    );
  }
  return { status: response.status, json: response.json };
}

export interface TrackedAccountResolverDependencies {
  db: Db;
  fabric: ConnectorFabric;
}

export async function resolveTrackedSocialAccount(
  deps: TrackedAccountResolverDependencies,
  input: {
    workspaceId: string;
    accountId: string;
    connectionId: string;
    force?: boolean;
    runtime?: TrackedResolutionRuntime;
  },
): Promise<TrackedSocialAccount> {
  const account = getTrackedSocialAccount(
    deps.db,
    input.workspaceId,
    input.accountId,
  );
  if (!account) throw new TrackedAccountNotFoundError();
  if (!account.enabled) throw new TrackedAccountConnectionError();

  const connection = getConnection(
    deps.db,
    input.workspaceId,
    input.connectionId,
  );
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.providerKey !== PLATFORM_PROVIDER[account.platform]
  ) {
    throw new TrackedAccountConnectionError();
  }
  if (input.force !== true && account.externalId) return account;

  try {
    let externalId: string;
    if (account.platform === "x") {
      externalId = await resolveXUserId({
        handle: account.handle,
        get: (path) =>
          providerGet(
            deps,
            connection,
            path,
            PROVIDER_BASE_URL.twitter,
            input.runtime,
          ),
      });
    } else if (account.platform === "linkedin") {
      externalId = await resolveLinkedInOrganizationUrn({
        target: account.handle,
        get: (path) =>
          providerGet(
            deps,
            connection,
            path,
            PROVIDER_BASE_URL.linkedin,
            input.runtime,
          ),
      });
    } else if (account.platform === "reddit") {
      externalId = account.handle;
    } else {
      if (connection.config.authArchitecture !== "instagram_login") {
        throw new ProviderCapabilityError(
          "reconnect_required",
          "Reconnect Instagram with direct Instagram Login.",
        );
      }
      const requested = account.handle.replace(/^@+/, "").toLowerCase();
      const connected = connection.externalAccountHandle
        ?.replace(/^@+/, "")
        .toLowerCase();
      if (!connected || !connection.externalAccountId) {
        throw new ProviderCapabilityError(
          "reconnect_required",
          "Reconnect Instagram to bind its professional account.",
        );
      }
      if (requested !== connected) {
        throw new ProviderCapabilityError(
          "unsupported_target",
          "Instagram Login can resolve only its connected account.",
        );
      }
      externalId = connection.externalAccountId;
    }
    return persistResolutionSuccess(deps.db, account, externalId);
  } catch (error) {
    if (error instanceof ProviderCapabilityError) {
      persistResolutionFailure(deps.db, account, error);
    }
    throw error;
  }
}

export async function resolveTrackedAccountsForSource(
  deps: TrackedAccountResolverDependencies,
  input: {
    source: DiscoverySource;
    accounts: TrackedSocialAccount[];
    connectionId: string;
    runtime: TrackedResolutionRuntime;
  },
): Promise<TrackedSocialAccount[]> {
  const resolved: TrackedSocialAccount[] = [];
  for (const account of input.accounts) {
    resolved.push(
      await resolveTrackedSocialAccount(deps, {
        workspaceId: input.source.workspaceId,
        accountId: account.id,
        connectionId: input.connectionId,
        force: false,
        runtime: input.runtime,
      }),
    );
  }
  return resolved;
}
```

Sequential resolution makes the shared call/byte counters a hard upper bound
rather than allowing parallel calls to oversubscribe it. A capability failure
changes only `lastError`; budget/abort errors do not fabricate an account-level
provider failure.

- [ ] **Step 7: Resolve referenced accounts before target reconciliation**

At the start of `runClaimedDiscoverySource`, initialize the normal source
`calls`/`bytes` counters before loading referenced accounts. When the source
has a connection, await:

```ts
const resolutionMetrics = { calls: 0, bytes: 0 };
const resolved = await resolveTrackedAccountsForSource(
  { db: deps.db, fabric: deps.fabric },
  {
    source: initial,
    accounts: referencedAccounts,
    connectionId: initial.connectionId,
    runtime: {
      signal,
      maxCalls: budget.maxCalls,
      maxBytes: budget.maxBytes,
      maxResponseBytes: budget.maxResponseBytes,
      metrics: resolutionMetrics,
    },
  },
);
calls += resolutionMetrics.calls;
bytes += resolutionMetrics.bytes;
```

Map the returned rows into `ResolvedTrackedAccount` before `targetsForSource`.
If resolution fails, copy `resolutionMetrics` into the source result metrics
before `safeExecutionFailure` persists its stable code. Inline handles still
resolve within their provider adapter, but only tracked rows are cached.

- [ ] **Step 8: Add the explicit retry route and UI action**

Add:

```ts
export const resolveTrackedSocialAccountInputSchema = z.object({
  connectionId: z.string().uuid(),
});
```

Register the POST route, parse its body, and call:

```ts
await resolveTrackedSocialAccount(
  { db, fabric: connectors },
  {
    workspaceId: request.params.id,
    accountId: request.params.accountId,
    connectionId: parsed.data.connectionId,
    force: true,
  },
);
```

Map `TrackedAccountNotFoundError` to HTTP 404 `account_not_found` and
`ProviderCapabilityError` to HTTP 409. Map
`TrackedAccountConnectionError` to HTTP 404 `connection_unavailable` for
missing, foreign, disconnected, and wrong-provider connections.

On each tracked-account card, show `lastResolvedAt` or `lastError`, offer a
compatible connection select, and post the selected connection ID from a
`Retry resolution` button. Refresh the tracked-account list from the response;
never render an editable external-ID field.

- [ ] **Step 9: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/tracked-account-resolver.test.ts apps/api/test/connected-discovery.test.ts
npm run typecheck
```

Expected: all selected tests pass, failure timestamps remain unchanged, first
use writes the cache before fetching posts, and typecheck exits 0.

- [ ] **Step 10: Commit and finish TAP-56**

```bash
git add packages/contracts/src/index.ts apps/api/src/discovery/provider-account-resolvers.ts apps/api/src/discovery/connected-adapters.ts apps/api/src/services/tracked-account-resolver.ts apps/api/src/services/tracked-social-accounts.ts apps/api/src/services/discovery.ts apps/api/src/routes/discovery.ts apps/api/test/tracked-account-resolver.test.ts apps/api/test/connected-discovery.test.ts 'apps/web/app/workspaces/[id]/discovery/page.tsx'
git commit -m "feat: resolve and cache tracked account identities"
```

Comment with SHA and evidence, then move TAP-56 to `Done`.

---

### Task 7: TAP-57 — Reserve inert vocabulary and annotate activation milestones

**Files:**

- Create: `apps/api/drizzle/0058_sprint_50_reserved_vocabulary.sql`
- Create: `apps/api/drizzle/meta/0058_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `apps/api/src/discovery/adapters.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/discovery-bounds.test.ts`
- Modify: `apps/api/test/sprint50-migrations.test.ts`
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
- Modify: `docs/founder-acceptance-tests.md`

**Interfaces:**

- Extends the existing `RESERVED_DISCOVERY_SOURCE_TYPES` constant to
  `google_trends`, `g2`, `capterra`, and `intent`; its helper signature remains
  unchanged.
- Does not delete `IntentProvider` or the injected test seam.
- Adds comments only around `PACKAGE_SOURCE_ROLES` and
  `DELIVERABLE_PRODUCTION_STATUSES`; their runtime types and values do not
  change.

- [ ] **Step 1: Read TAP-57 and move only it to `In Progress`**

Add a Plane note that G2/Capterra/intent activation has no scheduled sprint and
needs a provider-selection sprint; do not claim Sprint 60 activates them.

- [ ] **Step 2: Write failing reserved-vocabulary and migration tests**

Assert:

```ts
expect(RESERVED_DISCOVERY_SOURCE_TYPES).toEqual([
  "google_trends",
  "g2",
  "capterra",
  "intent",
]);
for (const type of ["g2", "capterra", "intent"] as const) {
  expect(isReservedDiscoverySourceType(type)).toBe(true);
  expect(isLiveSourceType(type)).toBe(false);
}
```

POST each source type with `{ config: { query: "market" } }` and expect 409
`source_reserved`. Seed an active row and queued job for each, apply 0058, and
assert every source is disabled/reserved and every job is skipped with
`source_reserved`. Run the scheduler with a configured fake `IntentProvider`
and prove the intent row still queues zero jobs.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts
```

Expected: FAIL because only Google Trends is reserved and configured intent can
still become eligible.

- [ ] **Step 4: Extend the reserved set and remove intent's eligibility exception**

Set:

```ts
export const RESERVED_DISCOVERY_SOURCE_TYPES = [
  "google_trends",
  "g2",
  "capterra",
  "intent",
] as const satisfies readonly DiscoverySourceType[];
```

Delete the scheduler exception that treats configured intent as eligible.
Retain the `IntentProvider` dependency and execution seam so future activation
can be implemented without a destructive interface change.

- [ ] **Step 5: Add truthful contract comments**

Place this comment above the three provider vocabulary entries:

```ts
// Reserved. Activation sprint is not scheduled; a provider-specific sprint
// must be created before g2, capterra, or intent becomes available.
```

Place:

```ts
// Reserved orchestration vocabulary. Package source roles activate in Sprint 62.
```

above `PACKAGE_SOURCE_ROLES`, and:

```ts
// Reserved orchestration vocabulary. Deliverable production state activates in Sprint 63.
```

above `DELIVERABLE_PRODUCTION_STATUSES`.

- [ ] **Step 6: Add and register migration 0058**

Create `apps/api/drizzle/0058_sprint_50_reserved_vocabulary.sql`:

```sql
UPDATE discovery_jobs
SET
  status = 'skipped',
  finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  error = 'source_reserved',
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL
WHERE source_id IN (
  SELECT id
  FROM discovery_sources
  WHERE type IN ('g2', 'capterra', 'intent')
)
AND status IN ('queued', 'running');
--> statement-breakpoint
UPDATE discovery_sources
SET
  status = 'reserved',
  enabled = 0,
  last_error = 'source_reserved',
  backoff_until = NULL
WHERE type IN ('g2', 'capterra', 'intent');
```

Copy the 0057 schema body to 0058, then set the snapshot chain header to:

```json
{
  "version": "6",
  "dialect": "sqlite",
  "id": "fdf29574-ae02-44e7-888c-98629af8b148",
  "prevId": "5ae86b8b-24b8-47d0-9965-686438c57657"
}
```

Append:

```json
{
  "idx": 58,
  "version": "6",
  "when": 1785491400000,
  "tag": "0058_sprint_50_reserved_vocabulary",
  "breakpoints": true
}
```

- [ ] **Step 7: Update UI and founder copy**

Label all four reserved types with `— reserved`, prevent their add/activation
flow, and state that no production provider is selected. Keep existing rows
visible. In founder acceptance docs, require verification that reserved rows
are visible but cannot run; do not ask the founder for provider API keys.

- [ ] **Step 8: Run focused verification and typecheck**

Run:

```bash
npm test -- apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts
npm run typecheck
```

Expected: all selected tests pass, configured intent remains unqueued, and
typecheck exits 0.

- [ ] **Step 9: Commit and finish TAP-57**

```bash
git add docs/founder-acceptance-tests.md packages/contracts/src/index.ts apps/api/drizzle/0058_sprint_50_reserved_vocabulary.sql apps/api/drizzle/meta/0058_snapshot.json apps/api/drizzle/meta/_journal.json apps/api/src/services/discovery.ts apps/api/src/services/discovery-scheduler.ts apps/api/src/discovery/adapters.ts apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/sprint50-migrations.test.ts 'apps/web/app/workspaces/[id]/discovery/page.tsx'
git commit -m "fix: reserve unimplemented discovery vocabulary"
```

Comment with SHA, the unscheduled-provider note, and verification evidence,
then move TAP-57 to `Done`.

---

### Task 8: Sprint 50 automated founder-acceptance audit and epic closure

**Files:**

- Modify: `docs/founder-acceptance-tests.md`

**Interfaces:**

- Adds no production interface.
- Treats the focused tests from Tasks 1–7 as one acceptance evidence bundle,
  avoiding a duplicate end-to-end fixture that could pass while individual
  provider or transaction invariants regress.

- [ ] **Step 1: Run the automated founder-acceptance evidence bundle**

Run:

```bash
npm test -- apps/api/test/provider-config.test.ts apps/api/test/provider-account-resolvers.test.ts apps/api/test/connect-social.test.ts apps/api/test/connectors.test.ts apps/api/test/social-read-linkedin.test.ts apps/api/test/social-read-instagram.test.ts apps/api/test/connected-discovery.test.ts apps/api/test/adapters.test.ts apps/api/test/discovery.test.ts apps/api/test/discovery-bounds.test.ts apps/api/test/discovery-dedupe.test.ts apps/api/test/tracked-account-resolver.test.ts apps/api/test/sprint50-migrations.test.ts apps/api/test/launches.test.ts apps/api/test/carousels.test.ts
```

Expected: all selected files pass. Together they prove strict LinkedIn policy,
organization resolution/no self fallback, direct Instagram identity and
own-media behavior, reserved-source rejection and scheduler exclusion,
tracked-ID lifecycle, dedupe promotion/rollback, legacy repair, and migrations.

- [ ] **Step 2: Run the dead-provider-surface audit**

Run:

```bash
if rg -n '/v2/userinfo' apps/api/src/discovery/connected-adapters.ts; then exit 1; fi
if rg -n 'trendingsearches/daily/rss' apps/api/src; then exit 1; fi
if rg -n 'graph\\.facebook\\.com|/me/accounts|ig_hashtag_search|business_discovery' apps/api/src/connectors/social/instagram.ts apps/api/src/discovery/connected-adapters.ts; then exit 1; fi
```

Expected: no output and exit 0. The audit is intentionally scoped so LinkedIn
publishing identity and Meta Ads can retain their valid, unrelated surfaces.

- [ ] **Step 3: Finish the founder checklist**

Update `docs/founder-acceptance-tests.md` with a Sprint 50 section that asks the
founder to verify:

- LinkedIn organization handle success and visible unresolvable-handle error.
- Direct Instagram connection identity, own-media run, and honest unsupported
  competitor/hashtag messages.
- Reserved-source labels and blocked add/activation behavior.
- Tracked-account resolution timestamps/errors and retry control.
- Source deletion leaving the surviving story and provenance visible.

State that the Task 8 evidence bundle covers migrations, transaction rollback,
dangling repair, and no-fallback request logs, so the founder does not manually
inspect database rows.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm run typecheck
npm test -- --maxWorkers=4
npm audit
git status --short
```

Expected: typecheck exits 0; all test files and tests pass; `npm audit` reports
only the inherited baseline findings (19 total: 1 low, 8 moderate, 8 high,
2 critical) unless dependency state changed during implementation; git status
shows only the acceptance-document change before the final commit.

- [ ] **Step 5: Commit acceptance evidence**

```bash
git add docs/founder-acceptance-tests.md
git commit -m "docs: record Sprint 50 founder acceptance"
```

- [ ] **Step 6: Audit Plane and close TAP-9**

Pull TAP-51 through TAP-57 just-in-time and verify every child is `Done` with a
commit SHA and passing command evidence. Add one TAP-9 completion comment
containing:

- the seven child cards and their commit SHAs;
- full typecheck result;
- full test file/test counts;
- inherited or changed audit counts;
- founder checklist path; and
- the explicit note that G2/Capterra/intent activation remains unscheduled.

Move TAP-9 to `Done` only after that audit succeeds. Keep the sprint branch
unmerged until founder acceptance or an explicit merge request.

---

## Execution Order and Review Gates

Execute tasks strictly in order because later cards consume earlier interfaces:

1. TAP-51 provides shared LinkedIn policy.
2. TAP-52 provides provider-capability errors and organization resolution.
3. TAP-53 establishes reserved source status.
4. TAP-54 consumes capability errors for direct Instagram.
5. TAP-55 is data-safety isolated from provider work but remains in Plane card
   order.
6. TAP-56 reuses LinkedIn/X provider resolvers and Instagram bound identity.
7. TAP-57 extends the reserved set without changing its interface.
8. Cross-card acceptance and epic closure run last.

At every gate, inspect `git diff --check`, the focused test output, typecheck,
the exact staged file list, and the current Plane child before committing.
