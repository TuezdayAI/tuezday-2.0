# Sprint 48 Safe Fetch and Tenant Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Sprint 48 release blockers by putting every workspace-influenced outbound URL behind one guarded fetch service and making discovery/signal writes workspace-safe, atomic, and transition-valid.

**Architecture:** A focused `safe-fetch/` package owns URL policy, IP classification, DNS resolution, address pinning, redirects, bounded streaming/decompression, MIME validation, and redacted failures. `buildApp` constructs it once from operator policy and injects it only into discovery and website-scraping paths; trusted provider clients retain their existing `fetcher`. Signal matching becomes a pure pre-write judgment followed by one synchronous SQLite transaction, while discovery source create/update performs complete workspace-scoped validation before one persistence step.

**Tech Stack:** TypeScript ESM, Node.js 20+, Fastify 5, Drizzle ORM with better-sqlite3, Undici 6, ipaddr.js 2, Zod 3, Vitest 3.

## Global Constraints

- Work only on branch `sprint-48-safe-fetch-tenant-isolation` in `.worktrees/sprint-48-safe-fetch-tenant-isolation`.
- Preserve the user’s dirty main checkout; never copy, reset, or overwrite unrelated changes.
- Use TDD for every behavior: failing focused test, minimal implementation, passing focused test.
- Read the full Plane card and comments immediately before starting each task.
- Complete Plane cards in this order: TAP-35, TAP-36, TAP-37, TAP-38, TAP-39, TAP-40, TAP-41, TAP-42, TAP-43.
- Move a child card to `Done` only after its focused tests, relevant regressions, and `npm run typecheck` pass.
- Add a Plane completion comment containing summary, commands, result counts, and commit SHA before setting `Done`.
- Move TAP-7 to `In Progress` after TAP-35 is complete; move it to `Done` only after all child cards and full sprint verification pass.
- HTTPS is accepted by default; HTTP requires `TUEZDAY_SAFE_FETCH_ALLOW_HTTP=true`.
- Workspace users cannot disable destination, redirect, timeout, size, decompression, encoding, or MIME safety.
- Fixed limits are 5,000 ms connect time, 20,000 ms total time, 5 redirects, 2 MiB compressed bytes, 5 MiB decoded bytes, and 20:1 decoded/compressed expansion.
- Feed/XML MIME types are `application/rss+xml`, `application/atom+xml`, `application/xml`, `text/xml`, and `text/plain`.
- JSON MIME types are `application/json`, `text/json`, and structured `+json`.
- Website MIME types are `text/html`, `application/xhtml+xml`, and `text/plain`.
- Missing or unrecognized content types fail closed.
- Unknown and foreign related UUIDs produce indistinguishable `404` results and persist nothing.
- Expected safe-fetch error codes are `invalid_url`, `scheme_blocked`, `credentials_blocked`, `destination_blocked`, `dns_failed`, `redirect_blocked`, `redirect_limit`, `connect_timeout`, `total_timeout`, `compressed_limit`, `decoded_limit`, `decompression_ratio`, `encoding_blocked`, `mime_blocked`, `upstream_status`, and `transport_failed`.
- Public/persisted errors never include resolved addresses, internal hostnames, credentials, rejected redirect targets, response bodies, or raw transport exceptions.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8`.
- Do not merge to `main`; founder acceptance is required before Sprint 49 begins.

---

## File Structure

### New production files

- `apps/api/src/safe-fetch/errors.ts` — stable error codes and redacted public messages.
- `apps/api/src/safe-fetch/policy.ts` — fixed limits, MIME profiles, and operator HTTP flag parsing.
- `apps/api/src/safe-fetch/destination.ts` — absolute URL validation plus centralized public-IP classification.
- `apps/api/src/safe-fetch/transport.ts` — DNS resolver contract and Undici transport pinned to a validated address.
- `apps/api/src/safe-fetch/body.ts` — bounded compressed/decoded streaming and supported content decoding.
- `apps/api/src/safe-fetch/service.ts` — per-hop orchestration, redirect handling, deadlines, status/MIME enforcement.
- `apps/api/src/safe-fetch/index.ts` — public types and composition exports.
- `docs/specs/sprint-48-tenant-invariant-audit.md` — TAP-42 audit evidence and enforced invariants.

### New test files

- `apps/api/test/safe-fetch-policy.test.ts` — environment policy and URL/IP adversarial matrix.
- `apps/api/test/safe-fetch-routing.test.ts` — DNS, address pinning, redirects, and timeouts.
- `apps/api/test/safe-fetch-body.test.ts` — compressed/decoded byte, ratio, encoding, MIME, and redaction tests.
- `apps/api/test/safe-fetch-fixtures.ts` — deterministic fixture implementation for integration suites.

### Existing files modified

- `apps/api/package.json`, `package-lock.json` — direct `undici@^6.28.0` and `ipaddr.js@^2.4.0` dependencies.
- `.env.example` — documented `TUEZDAY_SAFE_FETCH_ALLOW_HTTP=false`.
- `apps/api/src/app.ts` — optional `safeFetch` dependency and production composition.
- `apps/api/src/routes/workspaces.ts`, `apps/api/src/routes/brand-profile.ts` — safe scraper dependency.
- `apps/api/src/services/brand-profile.ts`, `apps/api/src/services/scrape.ts` — bounded HTML reads.
- `apps/api/src/discovery/adapters.ts` — bounded XML/JSON reads.
- `apps/api/src/routes/discovery.ts`, `apps/api/src/services/discovery.ts` — safe fetch, safe errors, reference validation, atomic accept, and full source transitions.
- `apps/api/src/db/index.ts` — shared database executor type for top-level and transaction-scoped handles.
- `apps/api/src/services/matching.ts`, `apps/api/src/services/signals.ts` — pure match judgment plus transaction-scoped persistence.
- `apps/api/src/routes/signals.ts`, `apps/api/src/routes/public-api.ts` — uniform related-object 404 mapping.
- `apps/api/test/adapters.test.ts`, `apps/api/test/brand-profile.test.ts`, `apps/api/test/discovery.test.ts`, `apps/api/test/connected-discovery.test.ts`, `apps/api/test/signals.test.ts`, `apps/api/test/public-api.test.ts`, `apps/api/test/workspaces.test.ts` — migrated fixtures and security regressions.

---

### Task 1: TAP-35 — Safe-fetch foundation

**Files:**
- Create: `apps/api/src/safe-fetch/errors.ts`
- Create: `apps/api/src/safe-fetch/policy.ts`
- Create: `apps/api/src/safe-fetch/destination.ts`
- Create: `apps/api/src/safe-fetch/index.ts`
- Create: `apps/api/test/safe-fetch-policy.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `SafeFetchService`, `SafeFetchRequest`, `SafeFetchResult`, `SafeFetchProfile`, `SafeFetchError`, `SafeFetchErrorCode`, `SafeFetchPolicy`, `createSafeFetchPolicy()`, `validateSafeFetchUrl()`, and `assertPublicAddress()`.
- Consumes: no Sprint 48 interfaces.

- [ ] **Step 1: Pull TAP-35 and its comments from Plane**

Read work item `TAP-35` immediately before implementation and record any acceptance change in this plan before writing code.

- [ ] **Step 2: Install explicit runtime dependencies**

Run:

```bash
npm install -w apps/api undici@^6.28.0 ipaddr.js@^2.4.0
```

Expected: `apps/api/package.json` lists both packages under `dependencies`; `package-lock.json` records the resolved versions; no audit fixer runs.

- [ ] **Step 3: Write failing policy and adversarial URL tests**

Create table-driven tests with this shape:

```ts
describe("createSafeFetchPolicy", () => {
  it("defaults HTTP off and enables it only for the literal true value", () => {
    expect(createSafeFetchPolicy({}).allowHttp).toBe(false);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true" }).allowHttp).toBe(true);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "1" }).allowHttp).toBe(false);
    expect(createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "garbage" }).allowHttp).toBe(false);
  });
});

it.each([
  ["http default", "http://example.com", "scheme_blocked"],
  ["credentials", "https://user:secret@example.com", "credentials_blocked"],
  ["loopback", "https://127.0.0.1", "destination_blocked"],
  ["metadata", "https://169.254.169.254/latest/meta-data", "destination_blocked"],
  ["IPv6 loopback", "https://[::1]/", "destination_blocked"],
  ["IPv4-mapped private", "https://[::ffff:10.0.0.1]/", "destination_blocked"],
  ["localhost", "https://api.localhost/", "destination_blocked"],
])("rejects %s", (_label, url, code) => {
  expect(() => validateSafeFetchUrl(url, createSafeFetchPolicy({})))
    .toThrow(expect.objectContaining({ code }));
});
```

Cover every IPv4/IPv6 class in the approved spec, public IPv4/IPv6 literals, malformed/non-absolute URLs, `file:`, `ftp:`, missing hosts, metadata aliases, mixed-case/trailing-dot host normalization, and HTTP enabled by the operator policy.

- [ ] **Step 4: Run the tests and confirm the RED state**

Run:

```bash
npm test -- safe-fetch-policy.test.ts
```

Expected: FAIL because `../src/safe-fetch` does not exist.

- [ ] **Step 5: Implement stable errors and fixed policy**

Use an exhaustive code union and one redacted public message per code:

```ts
export const SAFE_FETCH_ERROR_CODES = [
  "invalid_url", "scheme_blocked", "credentials_blocked", "destination_blocked",
  "dns_failed", "redirect_blocked", "redirect_limit", "connect_timeout",
  "total_timeout", "compressed_limit", "decoded_limit", "decompression_ratio",
  "encoding_blocked", "mime_blocked", "upstream_status", "transport_failed",
] as const;

export type SafeFetchErrorCode = (typeof SAFE_FETCH_ERROR_CODES)[number];

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SafeFetchError";
  }
}
```

Define immutable fixed defaults and predefined content profiles:

```ts
export const SAFE_FETCH_LIMITS = Object.freeze({
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 20_000,
  maxRedirects: 5,
  maxCompressedBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 5 * 1024 * 1024,
  maxExpansionRatio: 20,
});

export type SafeFetchLimits = typeof SAFE_FETCH_LIMITS;
export type SafeFetchProfile = "feed" | "json" | "website";

export function createSafeFetchPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SafeFetchPolicy {
  return {
    allowHttp: env.TUEZDAY_SAFE_FETCH_ALLOW_HTTP === "true",
    limits: SAFE_FETCH_LIMITS,
  };
}
```

- [ ] **Step 6: Implement centralized URL and address validation**

Use `ipaddr.js` to normalize IPv4, IPv6, and IPv4-mapped IPv6 before classification. `assertPublicAddress(address)` must reject every non-unicast or non-public range, including ranges that ipaddr labels `private`, `loopback`, `linkLocal`, `uniqueLocal`, `carrierGradeNat`, `multicast`, `reserved`, `unspecified`, `documentation`, `benchmarking`, or `broadcast`. Add explicit metadata aliases and `169.254.169.254`/`100.100.100.200` guards.

The public URL function has this exact contract:

```ts
export function validateSafeFetchUrl(input: string, policy: SafeFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw safeFetchError("invalid_url", cause);
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw safeFetchError("scheme_blocked");
  }
  if (url.username || url.password) throw safeFetchError("credentials_blocked");
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) throw safeFetchError("destination_blocked");
  if (isIP(hostname)) assertPublicAddress(hostname);
  return url;
}
```

Export service-facing contracts from `index.ts`:

```ts
export interface SafeFetchRequest {
  url: string;
  profile: SafeFetchProfile;
  headers?: Readonly<Record<string, string>>;
  limits?: Partial<Pick<SafeFetchLimits, "maxCompressedBytes" | "maxDecodedBytes">>;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export interface SafeFetchService {
  validateUrl(url: string): URL;
  fetch(request: SafeFetchRequest): Promise<SafeFetchResult>;
}
```

Validate request overrides so they may only lower the two body limits. Reject
zero, negative, non-integer, or operator-limit-exceeding values. Reject
destination-authority and credential-bearing request headers (`host`,
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `connection`,
`transfer-encoding`, and `upgrade`); callers may set only benign representation
and identification headers such as `accept` and `user-agent`.

- [ ] **Step 7: Document the operator flag**

Add:

```dotenv
# Safe outbound URL policy. HTTPS is always allowed; plain HTTP remains off
# unless the deployment operator explicitly opts in.
TUEZDAY_SAFE_FETCH_ALLOW_HTTP=false
```

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm test -- safe-fetch-policy.test.ts
npm run typecheck
```

Expected: all policy tests PASS and every workspace typecheck PASS.

- [ ] **Step 9: Commit TAP-35**

```bash
git add .env.example apps/api/package.json package-lock.json apps/api/src/safe-fetch apps/api/test/safe-fetch-policy.test.ts
git commit -m "feat(api): add safe-fetch policy foundation" -m "Co-Authored-By: Claude Opus 4.8"
```

- [ ] **Step 10: Complete TAP-35 in Plane**

Add the verified commands/result counts and commit SHA to TAP-35, set TAP-35 to `Done`, then set TAP-7 to `In Progress`.

---

### Task 2: TAP-36 — DNS resolution and redirect revalidation

**Files:**
- Create: `apps/api/src/safe-fetch/transport.ts`
- Create: `apps/api/src/safe-fetch/service.ts`
- Create: `apps/api/test/safe-fetch-routing.test.ts`
- Modify: `apps/api/src/safe-fetch/index.ts`

**Interfaces:**
- Consumes: `SafeFetchPolicy`, `SafeFetchError`, `SafeFetchRequest`, `SafeFetchResult`, `validateSafeFetchUrl()`, and `assertPublicAddress()`.
- Produces: `SafeFetchResolver`, `SafeFetchTransport`, `PinnedRequest`, `TransportResponse`, `UndiciSafeFetchTransport`, `DefaultSafeFetchService`, and `createSafeFetchService()`.

- [ ] **Step 1: Pull TAP-36 and its comments from Plane**

Read `TAP-36` and reconcile its acceptance criteria before code changes.

- [ ] **Step 2: Write failing DNS, pinning, and redirect tests**

Use deterministic resolver and transport fakes:

```ts
const resolver: SafeFetchResolver = {
  async resolve(hostname) {
    return answers.get(hostname) ?? [];
  },
};

const transport: SafeFetchTransport = {
  async request(input) {
    recorded.push(input);
    return responses.shift()!;
  },
};
```

Test:

- a hostname with one public answer succeeds;
- empty, malformed, private-only, and mixed public/private answer sets fail `dns_failed` or `destination_blocked`;
- `PinnedRequest.address` exactly equals one validated answer and the original hostname remains the TLS server name;
- a public URL redirecting to metadata/private/localhost is rejected before the second transport call;
- relative redirects resolve against the current URL;
- downgrade to HTTP fails unless policy allows HTTP;
- missing `Location`, redirect loops, and the sixth redirect fail safely;
- redirect responses are drained/destroyed without parsing their bodies.

- [ ] **Step 3: Run the routing tests and confirm the RED state**

Run:

```bash
npm test -- safe-fetch-routing.test.ts
```

Expected: FAIL because resolver, transport, and service implementations do not exist.

- [ ] **Step 4: Implement the resolver and pinned Undici transport**

Use these contracts:

```ts
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export interface PinnedRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  connectTimeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array> & { destroy(error?: Error): void };
}

export interface SafeFetchTransport {
  request(input: PinnedRequest): Promise<TransportResponse>;
}
```

`UndiciSafeFetchTransport` creates an `Agent` whose `connect.lookup` callback returns only `input.address`, sets `servername`/TLS verification from `input.url.hostname`, calls `undici.request` with `maxRedirections: 0`, and closes the per-hop dispatcher in a `finally`/body-destroy path.

- [ ] **Step 5: Implement per-hop DNS validation and manual redirects**

Implement this order in `DefaultSafeFetchService.fetch()`:

```ts
for (let redirects = 0; ; redirects += 1) {
  const url = this.validateUrl(currentUrl);
  const answers = await this.resolveAndValidate(url.hostname);
  const response = await this.transport.request({
    url,
    address: choosePinnedAddress(answers),
    headers: request.headers ?? {},
    signal: totalDeadline.signal,
    connectTimeoutMs: this.policy.limits.connectTimeoutMs,
  });
  if (!isRedirect(response.status)) return this.finishResponse(response, url, request.profile);
  if (redirects >= this.policy.limits.maxRedirects) throw safeFetchError("redirect_limit");
  const location = headerValue(response.headers, "location");
  response.body.destroy();
  if (!location) throw safeFetchError("redirect_blocked");
  currentUrl = new URL(location, url).toString();
}
```

Map resolver exceptions to `dns_failed`, unsafe answers to `destination_blocked`, redirect syntax/policy failures to `redirect_blocked`, and unexpected transport errors to `transport_failed`. Never put a URL, hostname, address, or raw cause text in the public message.

- [ ] **Step 6: Run routing, policy, and type checks**

Run:

```bash
npm test -- safe-fetch-policy.test.ts safe-fetch-routing.test.ts
npm run typecheck
```

Expected: all focused tests PASS; typecheck PASS.

- [ ] **Step 7: Commit and complete TAP-36**

```bash
git add apps/api/src/safe-fetch apps/api/test/safe-fetch-routing.test.ts
git commit -m "feat(api): pin safe fetch DNS and redirects" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-36 with evidence and SHA, then set it to `Done`.

---

### Task 3: TAP-37 — Bounded streaming, decoding, and MIME

**Files:**
- Create: `apps/api/src/safe-fetch/body.ts`
- Create: `apps/api/test/safe-fetch-body.test.ts`
- Modify: `apps/api/src/safe-fetch/service.ts`
- Modify: `apps/api/src/safe-fetch/policy.ts`

**Interfaces:**
- Consumes: `TransportResponse`, `SafeFetchProfile`, fixed policy limits, and stable errors.
- Produces: `readBoundedBody()`, `normalizeContentType()`, `assertAllowedMime()`, and supported `identity`, `gzip`, `deflate`, and `br` decoding.

- [ ] **Step 1: Pull TAP-37 and its comments from Plane**

Read `TAP-37` before editing.

- [ ] **Step 2: Write failing limit and MIME tests**

Build async chunk fixtures and compressed payloads with `node:zlib`. Include:

```ts
it("aborts a gzip bomb when the expansion ratio crosses 20:1", async () => {
  const compressed = gzipSync(Buffer.alloc(256_000, 0x61));
  await expect(readFixture(compressed, {
    contentEncoding: "gzip",
    maxExpansionRatio: 20,
  })).rejects.toMatchObject({ code: "decompression_ratio" });
  expect(body.destroyed).toBe(true);
});
```

Also prove:

- compressed count stops above 2 MiB;
- decoded count stops above 5 MiB;
- limits apply while streaming, not after buffering;
- `identity`, `gzip`, `deflate`, and `br` decode correctly;
- unknown or stacked encodings fail `encoding_blocked`;
- each profile accepts only its approved MIME list;
- `application/problem+json` satisfies JSON while `text/html` does not;
- missing/invalid content type fails before body consumption;
- stricter caller byte limits are honored, while attempts to raise fixed limits fail closed;
- credential, authority, and hop-by-hop request headers are rejected before transport;
- non-2xx upstream status destroys the body and fails `upstream_status`;
- a hanging transport hits 5-second connect classification;
- a slow body/redirect chain hits the single 20-second total deadline.

Use injectable timers/deadlines where needed so tests complete in milliseconds rather than real seconds.

- [ ] **Step 3: Run the body tests and confirm the RED state**

```bash
npm test -- safe-fetch-body.test.ts
```

Expected: FAIL because bounded body functions are absent.

- [ ] **Step 4: Implement MIME and encoding gates before body reads**

Normalize the MIME token before `;`, lowercase it, and compare only against the fixed profile sets. Structured JSON is accepted with:

```ts
const jsonMime = mime === "application/json" || mime === "text/json" || mime.endsWith("+json");
```

Reject missing/unknown MIME and unknown/multiple content encodings before consuming a body chunk.

- [ ] **Step 5: Implement bounded compressed and decoded streams**

Count compressed chunks before passing them through a supported zlib transform, count decoded chunks on output, and abort as soon as:

```ts
compressedBytes > maxCompressedBytes
decodedBytes > maxDecodedBytes
decodedBytes > Math.max(1, compressedBytes) * maxExpansionRatio
```

Always destroy the upstream body and decoder on limit, timeout, decode, or consumer failure. Concatenate bytes only after the bounded loop finishes.

- [ ] **Step 6: Connect deadlines, upstream status, MIME, and body reading to the service**

`DefaultSafeFetchService.fetch()` must create one total deadline before the first DNS lookup and reuse it across every redirect and body read. Translate Undici connect timeout codes to `connect_timeout`; translate the total deadline abort to `total_timeout`; retain `transport_failed` for other transport causes.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
npm test -- safe-fetch-policy.test.ts safe-fetch-routing.test.ts safe-fetch-body.test.ts
npm run typecheck
```

Expected: all safe-fetch tests PASS; typecheck PASS.

- [ ] **Step 8: Commit and complete TAP-37**

```bash
git add apps/api/src/safe-fetch apps/api/test/safe-fetch-body.test.ts
git commit -m "feat(api): bound safe fetch response resources" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-37 with evidence and SHA, then set it to `Done`.

---

### Task 4: TAP-38 — Safe failure classes and redaction

**Files:**
- Modify: `apps/api/src/safe-fetch/errors.ts`
- Modify: `apps/api/src/safe-fetch/service.ts`
- Modify: `apps/api/test/safe-fetch-policy.test.ts`
- Modify: `apps/api/test/safe-fetch-routing.test.ts`
- Modify: `apps/api/test/safe-fetch-body.test.ts`

**Interfaces:**
- Consumes: all safe-fetch error sites.
- Produces: exhaustive `toSafeFetchError()`, `safeFetchPublicMessage()`, and `serializeSafeFetchError()` behavior.

- [ ] **Step 1: Pull TAP-38 and its comments from Plane**

Read `TAP-38`.

- [ ] **Step 2: Write failing exhaustive classification/redaction tests**

For every expected code, assert the serialized shape is exactly:

```ts
{ code: error.code, message: safeFetchPublicMessage(error.code) }
```

Create hostile causes containing `169.254.169.254`, `db.internal`, `https://user:secret@host`, raw HTML, and socket details. Assert none appear in `.message`, `JSON.stringify(serialized)`, or persisted-safe text.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm test -- safe-fetch-policy.test.ts safe-fetch-routing.test.ts safe-fetch-body.test.ts
```

Expected: at least the exhaustive redaction/serialization assertions FAIL.

- [ ] **Step 4: Centralize error construction and serialization**

Implement:

```ts
export function serializeSafeFetchError(error: unknown): {
  code: SafeFetchErrorCode;
  message: string;
} {
  const safe = toSafeFetchError(error);
  return { code: safe.code, message: safe.message };
}
```

Keep the original error only in `cause`; never interpolate cause, URL, address, status text, headers, or body into `message`.

- [ ] **Step 5: Run the complete safe-fetch suite and typecheck**

```bash
npm test -- safe-fetch-policy.test.ts safe-fetch-routing.test.ts safe-fetch-body.test.ts
npm run typecheck
```

Expected: all safe-fetch tests PASS; typecheck PASS.

- [ ] **Step 6: Commit and complete TAP-38**

```bash
git add apps/api/src/safe-fetch apps/api/test/safe-fetch-*.test.ts
git commit -m "fix(api): redact safe fetch failures" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-38 with evidence and SHA, then set it to `Done`.

---

### Task 5: TAP-39 — Migrate discovery adapters and website scraping

**Files:**
- Create: `apps/api/test/safe-fetch-fixtures.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/routes/workspaces.ts`
- Modify: `apps/api/src/routes/brand-profile.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `apps/api/src/services/brand-profile.ts`
- Modify: `apps/api/src/services/scrape.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/discovery/adapters.ts`
- Modify: `apps/api/test/adapters.test.ts`
- Modify: `apps/api/test/brand-profile.test.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/workspaces.test.ts`
- Verify: `apps/api/src/discovery/connected-adapters.ts`
- Verify: `apps/api/test/connected-discovery.test.ts`

**Interfaces:**
- Consumes: `SafeFetchService.fetch({ url, profile, headers })`, `SafeFetchResult.text()`, `SafeFetchResult.json()`, and `SafeFetchService.validateUrl()`.
- Produces: `BuildAppOptions.safeFetch?: SafeFetchService`; keyless discovery and scraping no longer accept raw `Fetcher`.

- [ ] **Step 1: Pull TAP-39 and its comments from Plane**

Read `TAP-39`.

- [ ] **Step 2: Write the deterministic safe-fetch fixture**

Implement a test helper with exact behavior:

```ts
export function fixtureSafeFetch(
  responder: (request: SafeFetchRequest) => FixtureResponse | Promise<FixtureResponse>,
): SafeFetchService {
  const policy = createSafeFetchPolicy({ TUEZDAY_SAFE_FETCH_ALLOW_HTTP: "true" });
  return {
    validateUrl: (url) => validateSafeFetchUrl(url, policy),
    async fetch(request) {
      const fixture = await responder(request);
      if (fixture.error) throw fixture.error;
      return safeFetchResultFromBytes(request.url, fixture.status ?? 200, fixture.contentType, fixture.body);
    },
  };
}
```

Fixture MIME must be explicit so integration tests exercise the same caller profile choices.

- [ ] **Step 3: Convert adapter tests first and confirm production signatures fail**

Replace fixture `Fetcher` instances with `SafeFetchService`; assert feed adapters request `profile: "feed"` and Hacker News requests `profile: "json"`.

Run:

```bash
npm test -- adapters.test.ts
```

Expected: FAIL because `fetchSourceItems` still accepts a raw fetcher.

- [ ] **Step 4: Migrate every keyless adapter**

Change:

```ts
export async function fetchSourceItems(
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
  safeFetch: SafeFetchService,
): Promise<RawDiscoveredItem[]>
```

Use `profile: "feed"` for RSS, Google News, Reddit, YouTube, podcasts, Google Trends, and funding news; use `profile: "json"` plus `result.json<{ hits?: HnHit[] }>()` for Hacker News. Remove unbounded `Response.text()` and upstream URL-bearing errors.

- [ ] **Step 5: Convert scraping tests first and confirm RED**

Make `scrapeWebsite(websiteUrl, safeFetch)` fixtures return `text/html`; add a regression that a metadata root fails and no subpage is attempted.

Run:

```bash
npm test -- brand-profile.test.ts
```

Expected: FAIL until scrape/brand-profile signatures are migrated.

- [ ] **Step 6: Migrate website scraping and brand-profile composition**

`scrapeWebsite` calls:

```ts
const result = await safeFetch.fetch({
  url,
  profile: "website",
  headers: { "user-agent": USER_AGENT },
});
const html = result.text();
```

Change `runBrandProfile`, `registerBrandProfileRoutes`, and `registerWorkspaceRoutes` to accept `SafeFetchService`.

In `BuildAppOptions` add:

```ts
safeFetch?: SafeFetchService;
```

Construct production once:

```ts
const guardedFetch = safeFetch ?? createSafeFetchService(createSafeFetchPolicy());
```

Pass `guardedFetch` only to workspace brand-profile, brand-profile refresh, and discovery. Keep `fetcher` for connectors, analytics, mail, trusted provider services, and internal/operator endpoints.

- [ ] **Step 7: Migrate discovery integration tests and service wiring**

Pass the fixture safe fetch into `buildAuthedApp`, change `runDiscovery(..., safeFetch, ...)`, and persist safe errors as:

```ts
const safe = serializeSafeFetchError(err);
const message = `${safe.code}: ${safe.message}`;
```

Retain connected sources through `ConnectorFabric`; add/assert a connected-source test proving a workspace source config cannot supply or alter the provider proxy origin.

- [ ] **Step 8: Add create-time literal destination validation**

Before inserting RSS/podcast sources, call `safeFetch.validateUrl(input.config.feedUrl)`. Map a `SafeFetchError` to a route `400` body containing only stable code/message. Add the acceptance test that `http://169.254.169.254/` is rejected on source creation and that a pre-existing unsafe row is also rejected during fetch.

- [ ] **Step 9: Run migration regressions and typecheck**

```bash
npm test -- adapters.test.ts brand-profile.test.ts discovery.test.ts connected-discovery.test.ts workspaces.test.ts
npm run typecheck
```

Expected: all focused/integration tests PASS; typecheck PASS.

- [ ] **Step 10: Audit raw fetch use in the migrated boundary**

Run:

```bash
rg -n "fetch\\(|Response\\.text\\(|\\.text\\(\\)" apps/api/src/discovery apps/api/src/services/scrape.ts apps/api/src/services/brand-profile.ts
```

Expected: no raw network fetch or unbounded response text remains in keyless adapters/scraper; parser-local text methods are allowed only when operating on already bounded bytes.

- [ ] **Step 11: Commit and complete TAP-39**

```bash
git add apps/api/src/app.ts apps/api/src/routes/workspaces.ts apps/api/src/routes/brand-profile.ts apps/api/src/routes/discovery.ts apps/api/src/services/brand-profile.ts apps/api/src/services/scrape.ts apps/api/src/services/discovery.ts apps/api/src/discovery/adapters.ts apps/api/test
git commit -m "feat(api): guard discovery and scraping fetches" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-39 with evidence, raw-fetch audit result, and SHA; set it to `Done`.

---

### Task 6: TAP-40 — Workspace-scoped signal references

**Files:**
- Modify: `apps/api/src/services/signals.ts`
- Modify: `apps/api/src/routes/signals.ts`
- Modify: `apps/api/src/routes/public-api.ts`
- Modify: `apps/api/test/signals.test.ts`
- Modify: `apps/api/test/public-api.test.ts`

**Interfaces:**
- Consumes: existing `getPersona(db, workspaceId, id)` and `getCampaign(db, workspaceId, id)`.
- Produces: `SignalReferenceNotFoundError` and `resolveSignalReferences()`.

- [ ] **Step 1: Pull TAP-40 and its comments from Plane**

Read `TAP-40`.

- [ ] **Step 2: Write foreign/unknown reference tests before service changes**

Create two workspaces and a persona/campaign in the second. For both the authenticated signals route and API-key ideas route, submit the foreign UUID and a random unknown UUID. Assert:

```ts
expect(foreign.statusCode).toBe(404);
expect(unknown.statusCode).toBe(404);
expect(foreign.json()).toEqual(unknown.json());
expect(signalCount(db, targetWorkspaceId)).toBe(0);
expect(signalMatchCount(db, targetWorkspaceId)).toBe(0);
```

Test persona-only, campaign-only, and both IDs.

- [ ] **Step 3: Run the reference tests and confirm RED**

```bash
npm test -- signals.test.ts public-api.test.ts
```

Expected: foreign UUID cases currently create a signal and therefore FAIL.

- [ ] **Step 4: Resolve every supplied ID before insertion**

Implement:

```ts
export class SignalReferenceNotFoundError extends Error {
  constructor() {
    super("A related signal object was not found.");
    this.name = "SignalReferenceNotFoundError";
  }
}

export function resolveSignalReferences(
  db: Db,
  workspaceId: string,
  input: Pick<CreateSignalInput, "suggestedPersonaId" | "suggestedCampaignId">,
): void {
  if (input.suggestedPersonaId && !getPersona(db, workspaceId, input.suggestedPersonaId)) {
    throw new SignalReferenceNotFoundError();
  }
  if (input.suggestedCampaignId && !getCampaign(db, workspaceId, input.suggestedCampaignId)) {
    throw new SignalReferenceNotFoundError();
  }
}
```

Call it in every public signal creation service path before `db.insert(signals)`.

- [ ] **Step 5: Map both missing cases to the same public response**

Both routes return:

```ts
reply.status(404).send({ error: "related_object_not_found" })
```

Do not name persona/campaign or distinguish foreign from absent.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npm test -- signals.test.ts public-api.test.ts
npm run typecheck
```

Expected: all focused tests PASS; typecheck PASS.

- [ ] **Step 7: Commit and complete TAP-40**

```bash
git add apps/api/src/services/signals.ts apps/api/src/routes/signals.ts apps/api/src/routes/public-api.ts apps/api/test/signals.test.ts apps/api/test/public-api.test.ts
git commit -m "fix(api): scope signal references to workspaces" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-40 with evidence and SHA, then set it to `Done`.

---

### Task 7: TAP-41 — Atomic signal creation

**Files:**
- Modify: `apps/api/src/db/index.ts`
- Modify: `apps/api/src/services/matching.ts`
- Modify: `apps/api/src/services/signals.ts`
- Modify: `apps/api/test/signals.test.ts`

**Interfaces:**
- Consumes: validated signal input and existing matching context/prompt/parser.
- Produces: `DbExecutor`, `judgeSignalMatches()`, `persistSignalCreation()`, and optional test-only `SignalCreationHooks`.

- [ ] **Step 1: Pull TAP-41 and its comments from Plane**

Read `TAP-41`.

- [ ] **Step 2: Write fault-injection rollback tests**

Add service-level tests with hooks after signal insert and after each match/projection insert:

```ts
await expect(createSignalWithMatching(db, llm, workspaceId, input, {
  afterSignalInsert() { throw new Error("fault_after_signal"); },
})).rejects.toThrow("fault_after_signal");

expect(db.select().from(signals).all()).toEqual([]);
expect(db.select().from(signalMatches).all()).toEqual([]);
```

Repeat after match insertion and after convenience-field projection. Assert a successful operation commits exactly one signal and the expected matches.

- [ ] **Step 3: Run signal tests and confirm RED**

```bash
npm test -- signals.test.ts
```

Expected: rollback tests FAIL because creation currently inserts before later work.

- [ ] **Step 4: Add a transaction-compatible database executor**

In `db/index.ts` define:

```ts
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTransaction;
```

Change persistence-only helpers such as `insertSignalMatch` and signal row reads/writes used inside the transaction to accept `DbExecutor`. Keep context-building/LLM functions on `Db`.

- [ ] **Step 5: Separate asynchronous judgment from synchronous persistence**

Replace the write-owning scorer with:

```ts
export async function judgeSignalMatches(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  content: string,
): Promise<ParsedMatch[]>
```

It builds the same prompt, calls the LLM, and returns parsed matches without inserting, deleting, or updating. LLM errors remain best-effort and become an empty match list before the transaction begins.

- [ ] **Step 6: Persist the complete result in one transaction**

Create the row and match set only inside:

```ts
return db.transaction((tx) => {
  const row = insertSignalRow(tx, workspaceId, input, matches[0]);
  hooks?.afterSignalInsert?.();
  for (const match of matches) {
    insertSignalMatch(tx, workspaceId, row.id, match);
    hooks?.afterMatchInsert?.();
  }
  hooks?.beforeReturn?.();
  return readSignal(tx, workspaceId, row.id);
});
```

For explicit IDs, construct the score-100 match without calling the LLM. For unmatched signals, judge before the transaction and persist a signal with zero matches. Ensure convenience fields and response matches reflect the same committed match set.

- [ ] **Step 7: Run signal regressions and typecheck**

```bash
npm test -- signals.test.ts discovery.test.ts automation.test.ts priorities.test.ts
npm run typecheck
```

Expected: all related signal/matching regressions PASS; typecheck PASS.

- [ ] **Step 8: Commit and complete TAP-41**

```bash
git add apps/api/src/db/index.ts apps/api/src/services/matching.ts apps/api/src/services/signals.ts apps/api/test/signals.test.ts
git commit -m "fix(api): make signal creation atomic" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-41 with fault-injection evidence and SHA, then set it to `Done`.

---

### Task 8: TAP-42 — Tenant invariant audit and discovery triage atomicity

**Files:**
- Create: `docs/specs/sprint-48-tenant-invariant-audit.md`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/services/tracked-social-accounts.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`

**Interfaces:**
- Consumes: workspace-scoped getters, `DbExecutor`, and transaction-scoped signal/match helpers.
- Produces: `DiscoveryReferenceNotFoundError`, strict tracked-account resolution, and atomic `acceptDiscoveredItem()`.

- [ ] **Step 1: Pull TAP-42 and its comments from Plane**

Read `TAP-42`.

- [ ] **Step 2: Audit every in-scope related UUID**

Run:

```bash
rg -n "personaId|campaignId|connectionId|trackedAccountId|trackedAccountIds|sourceId|signalId|itemId" apps/api/src/services/discovery.ts apps/api/src/services/signals.ts apps/api/src/services/matching.ts apps/api/src/services/tracked-social-accounts.ts apps/api/src/routes/discovery.ts apps/api/src/routes/signals.ts
```

Record a table in `docs/specs/sprint-48-tenant-invariant-audit.md` with columns: path, supplied/reference ID, workspace predicate, pre-write validation, negative test, database constraint decision. The completed audit must explicitly cover signal persona/campaign IDs, discovery source connection IDs, tracked account IDs, discovered item/source IDs, item matches, signal matches, and item acceptance.

- [ ] **Step 3: Write failing tracked-account and accept rollback tests**

Add tests proving:

- foreign/unknown tracked-account IDs on source create/update produce identical `400` or `404` responses and store no source/change;
- a config that names two tracked IDs fails if even one is missing/foreign instead of silently dropping it;
- accepting an item with a fault after signal insert leaves the item `new` and stores no signal/match;
- accepting an item outside the workspace stays `404`;
- copied match persona/campaign IDs are workspace-valid at the moment of acceptance.

- [ ] **Step 4: Run discovery tests and confirm RED**

```bash
npm test -- discovery.test.ts connected-discovery.test.ts
```

Expected: silent tracked-ID dropping and partial accept rollback cases FAIL.

- [ ] **Step 5: Enforce strict tracked-account reference resolution**

Add a strict resolver:

```ts
export function requireTrackedAccounts(
  db: Db,
  workspaceId: string,
  ids: readonly string[],
): TrackedSocialAccount[] {
  const uniqueIds = [...new Set(ids)];
  const accounts = resolveTrackedAccounts(db, workspaceId, uniqueIds);
  if (accounts.length !== uniqueIds.length) throw new DiscoveryReferenceNotFoundError();
  return accounts;
}
```

Call it before source create/update persistence and connected fetch use. Validate that account platforms match the connected source provider where the source type requires it.

- [ ] **Step 6: Make discovered-item acceptance one transaction**

Inside one `db.transaction`, re-read the item by both `workspaceId` and `itemId`, confirm status `new`, validate/copy match references, insert the signal and signal matches, then update the item with a workspace-qualified predicate. Let all errors escape so the whole operation rolls back.

- [ ] **Step 7: Decide database constraints explicitly**

Do not add a migration merely to duplicate service policy. In the audit document, record that existing single-column foreign keys guarantee existence but not tenant pairing, while SQLite composite tenant foreign keys would require new composite unique keys across several legacy tables. Keep Sprint 48 enforcement in workspace-qualified services and tests unless the audit finds a clean existing composite key that can be referenced without table rebuild.

- [ ] **Step 8: Run tenant regressions, typecheck, and audit scan**

```bash
npm test -- discovery.test.ts connected-discovery.test.ts signals.test.ts public-api.test.ts
npm run typecheck
rg -n "where\\(eq\\([^,]+\\.id|where\\(inArray\\([^,]+\\.id" apps/api/src/services/discovery.ts apps/api/src/services/signals.ts apps/api/src/services/matching.ts apps/api/src/services/tracked-social-accounts.ts
```

Expected: tests/typecheck PASS; every raw ID-only write/read in the scan is either replaced with a workspace predicate, operates on a row already resolved within the same transaction, or is documented in the audit with its invariant.

- [ ] **Step 9: Commit and complete TAP-42**

```bash
git add docs/specs/sprint-48-tenant-invariant-audit.md apps/api/src/services/discovery.ts apps/api/src/services/tracked-social-accounts.ts apps/api/test/discovery.test.ts apps/api/test/connected-discovery.test.ts
git commit -m "fix(api): enforce discovery tenant invariants" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-42 with audit/test evidence and SHA, then set it to `Done`.

---

### Task 9: TAP-43 — Validate complete discovery-source PATCH transitions

**Files:**
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`

**Interfaces:**
- Consumes: `createDiscoverySourceInputSchema`, safe URL validation, connection validation, and strict tracked-account validation.
- Produces: `validateDiscoverySourceTransition()` and `deriveDiscoverySourceRuntimeState()`.

- [ ] **Step 1: Pull TAP-43 and its comments from Plane**

Read `TAP-43`.

- [ ] **Step 2: Write failing merged-transition tests**

Cover:

- replacing a valid RSS config with `{}` fails and preserves the stored row;
- switching connected mode without the required query/handle/list/hashtag fails and preserves the row;
- attaching a foreign/wrong-provider/disconnected connection fails and preserves the row;
- detaching a required connection fails and preserves the row;
- changing a feed URL to a literal metadata URL fails and preserves the row;
- a valid patch derives `active` versus `needs_api_key`;
- valid config/connection changes clear stale `lastError` and `backoffUntil`;
- disabling a source prevents queued execution state from surviving the transition;
- route error output is stable and redacted.

- [ ] **Step 3: Run discovery tests and confirm RED**

```bash
npm test -- discovery.test.ts connected-discovery.test.ts
```

Expected: partial config patches currently bypass canonical create rules and therefore FAIL.

- [ ] **Step 4: Merge and parse the complete resulting source**

Implement:

```ts
export function validateDiscoverySourceTransition(
  existing: DiscoverySource,
  patch: UpdateDiscoverySourceInput,
): CreateDiscoverySourceInput {
  return createDiscoverySourceInputSchema.parse({
    type: existing.type,
    name: patch.name ?? existing.name,
    config: patch.config ?? existing.config,
    connectionId: patch.connectionId === undefined
      ? existing.connectionId
      : patch.connectionId,
  });
}
```

Map Zod failures to route `400 invalid_input` without persistence. After parsing, run safe URL, connection, tracked-account, provider capability, and permission checks before the update statement.

- [ ] **Step 5: Derive status and scheduling state in one persistence step**

Use one pure function:

```ts
export function deriveDiscoverySourceRuntimeState(
  type: DiscoverySourceType,
  connectionId: string | null,
): Pick<DiscoverySourceRow, "status" | "lastError" | "backoffUntil"> {
  return {
    status: connectionId || isLiveSourceType(type) ? "active" : "needs_api_key",
    lastError: null,
    backoffUntil: null,
  };
}
```

Apply the validated editable fields plus derived runtime fields in one workspace-qualified update. Delete any queued (not running) discovery jobs when disabling or materially changing the source so stale work cannot execute old configuration.

- [ ] **Step 6: Run source transition regressions and typecheck**

```bash
npm test -- discovery.test.ts connected-discovery.test.ts discovery-jobs.test.ts
npm run typecheck
```

Expected: all source transition/job tests PASS; typecheck PASS.

- [ ] **Step 7: Commit and complete TAP-43**

```bash
git add apps/api/src/services/discovery.ts apps/api/src/routes/discovery.ts apps/api/test/discovery.test.ts apps/api/test/connected-discovery.test.ts
git commit -m "fix(api): validate discovery source transitions" -m "Co-Authored-By: Claude Opus 4.8"
```

Comment on TAP-43 with evidence and SHA, then set it to `Done`.

---

### Task 10: Sprint 48 release verification and TAP-7 completion

**Files:**
- Modify: `docs/specs/sprint-48-safe-fetch-tenant-isolation.md`
- Verify: all Sprint 48 files and Plane cards.

**Interfaces:**
- Consumes: all nine completed child-card deliverables.
- Produces: release acceptance evidence only; no new behavior.

- [ ] **Step 1: Confirm all child cards are Done and inspect TAP-7 comments**

Pull TAP-7 plus TAP-35 through TAP-43. If any child lacks completion evidence or is not `Done`, stop epic completion and repair that card first.

- [ ] **Step 2: Run the three founder acceptance cases**

Run the exact focused tests proving:

```bash
npm test -- signals.test.ts -t "foreign"
npm test -- discovery.test.ts -t "169.254.169.254"
npm test -- safe-fetch-body.test.ts -t "gzip bomb"
```

Expected:

- foreign persona signal creation returns `404` and persists no signal/match;
- metadata URL source creation and fetch both fail safely;
- gzip bomb aborts at byte/ratio bounds.

- [ ] **Step 3: Run complete verification**

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Expected: every workspace typecheck PASS; all test files/tests PASS; no whitespace errors; status contains only the intentional progress-log update before the final verification commit.

- [ ] **Step 4: Update the design progress log with evidence**

Append the date, child commit SHAs, focused acceptance counts, full typecheck result, and full test file/test counts. Do not change approved behavior.

- [ ] **Step 5: Commit verification evidence**

```bash
git add docs/specs/sprint-48-safe-fetch-tenant-isolation.md
git commit -m "docs: record Sprint 48 verification" -m "Co-Authored-By: Claude Opus 4.8"
```

- [ ] **Step 6: Re-run final clean-tree verification**

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Expected: typecheck and all tests PASS; no diff-check output; clean worktree.

- [ ] **Step 7: Complete TAP-7**

Add one epic comment summarizing all child cards, founder acceptance cases, final commands/counts, and the verification commit SHA. Set TAP-7 to `Done` only after the comment succeeds.

- [ ] **Step 8: Hand off for founder acceptance**

Report the branch, commit range, test/typecheck evidence, Plane state, known residual risks, and explicitly state that the branch was not merged to `main`.
