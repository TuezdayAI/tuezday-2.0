# Sprint 48 — Safe Fetch Service and Tenant Isolation

> **Status:** Founder acceptance audit passed; ready for founder merge
> **Date:** 2026-07-28
> **Branch:** `sprint-48-safe-fetch-tenant-isolation`
> **Base:** `main` at `03329c4`
> **Merge order:** `main` ← `sprint-48-safe-fetch-tenant-isolation`
> **Plane epic:** TAP-7
> **Source:** `docs/plans/prd-agentic-platform.md` §3 and
> `docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
> P1.1, P1.2, and P1.12

## 1. Goal

Close Sprint 48's three release-blocking defect classes:

1. User-controlled discovery and scraping URLs can currently reach unsafe network
   destinations and download unbounded responses.
2. Signal creation trusts supplied persona and campaign IDs without verifying that
   they belong to the signal workspace, and a mid-operation failure can leave a
   partial signal behind.
3. Updating a discovery source validates only the patch, not the resulting source,
   so a successful update can leave a permanently invalid or inert source.

The sprint introduces one guarded fetch boundary for untrusted URLs, enforces
workspace ownership before related records are written, makes signal creation
atomic, and validates discovery-source transitions as complete resulting objects.

## 2. Founder-approved product behavior

- Tuezday accepts HTTPS destinations by default.
- Plain HTTP is disabled by default and can be enabled only by an operator-level
  environment flag. It is not a workspace or per-source setting.
- Workspace users cannot opt out of network safety checks.
- Requests to local, private, link-local, metadata, multicast, reserved, or
  otherwise non-public destinations are rejected.
- Redirects receive the same checks as initial URLs.
- Excessive, compressed, slow, or unexpected responses are terminated within
  configured limits.
- User-visible and persisted errors identify a safe failure category without
  exposing internal addresses, fetched response bodies, or network details.
- Unknown and foreign related-object IDs both return `404`; the response does not
  reveal which case occurred.
- A failed multi-record operation persists none of its intended changes.

This sprint is security and correctness work. It adds no new customer-facing
feature or navigation.

## 3. Scope and Plane card order

The cards are delivered in dependency order. A card is complete only after its
focused tests, relevant regressions, and typecheck pass.

1. **TAP-35 — Safe-fetch foundation**
   - Introduce the shared service contract and production implementation.
   - Add the operator-only HTTP policy.
   - Reject invalid schemes, embedded credentials, unsafe hostnames, and unsafe
     literal IPv4 and IPv6 destinations.
   - Add the adversarial URL-validation matrix.
2. **TAP-36 — DNS and redirect protection**
   - Resolve and validate the destination before connection.
   - Pin the connection to a validated address so the transport cannot resolve a
     different address after validation.
   - Follow redirects manually, revalidating and repinning every hop.
   - Enforce a bounded redirect count.
3. **TAP-37 — Resource limits**
   - Bound connection time, total request time, compressed bytes, decoded bytes,
     decompression ratio, and accepted MIME types.
   - Consume response bodies as bounded streams; do not use unbounded
     `Response.text()`.
4. **TAP-38 — Safe failure classes**
   - Return stable failure codes for policy, DNS, redirect, timeout, size,
     decompression, MIME, upstream-status, and transport failures.
   - Persist and expose only redacted safe messages.
5. **TAP-39 — Migrate discovery and scraping**
   - Route every keyless discovery adapter and `services/scrape.ts` through the
     safe-fetch service.
   - Preserve fixture-driven tests through an injectable safe-fetch seam.
   - Audit connected discovery calls. Provider traffic already routed through the
     connector fabric must retain fixed provider origins and must not accept a
     workspace-supplied proxy origin.
6. **TAP-40 — Workspace-scoped reference resolution**
   - Resolve supplied persona, campaign, and other related IDs inside the target
     workspace before any insert.
   - Return indistinguishable `404` responses for unknown and foreign IDs.
7. **TAP-41 — Atomic signal creation**
   - Create the signal, explicit match, suggested projections, and response state
     inside one database transaction.
   - Fault-injection tests prove rollback at each failure point.
8. **TAP-42 — Cross-workspace invariant audit**
   - Audit related-object UUID write paths touched by discovery and signal flows.
   - Add service-enforced workspace checks everywhere in scope.
   - Add composite database constraints where they are portable and do not
     duplicate service policy.
9. **TAP-43 — Full source PATCH validation**
   - Merge the stored source with the patch.
   - Parse the complete resulting source through the canonical source schema.
   - Derive status and scheduling fields from the validated result.
   - Reject unsupported transitions without modifying the stored source.

## 4. Safe-fetch architecture

### 4.1 One guarded doorway

Untrusted URL fetches use a `SafeFetchService`, not raw `fetch`. The service owns
URL policy, address validation, redirect handling, transport selection, response
limits, content decoding, and safe error classification.

Callers provide only:

- the URL;
- the expected content families;
- an optional stricter limit profile;
- request headers that are safe for the destination.

Callers do not control whether HTTP, private addresses, redirects, or oversized
responses are allowed.

### 4.2 Transport choice

The production implementation uses `undici` as an explicit runtime dependency.
It provides a maintained HTTP transport with an injectable connection lookup,
manual redirect control, streaming bodies, and deterministic test seams.

A wrapper around global `fetch` is insufficient because checking DNS separately
from the connection leaves a rebinding gap: the checked address and the address
used by the transport can differ. A handwritten HTTP client would duplicate
security-sensitive protocol behavior without improving the product.

### 4.3 Operator configuration

The production policy is created once at the application composition root.

- `TUEZDAY_SAFE_FETCH_ALLOW_HTTP` defaults to `false`.
- Only an explicit true value enables HTTP.
- The flag never disables destination, redirect, timeout, size, decompression, or
  MIME checks.
- Invalid policy values fail closed to the secure default.

The first production policy uses these fixed defaults:

- 5 seconds to establish a connection;
- 20 seconds total wall-clock time per hop chain;
- 5 redirects;
- 2 MiB of compressed response bytes;
- 5 MiB of decoded response bytes;
- a maximum 20:1 decoded-to-compressed expansion ratio.

These values are represented as validated operator policy rather than
workspace-controlled fields. Sprint 48 adds no environment overrides for the
numeric limits. If later operational evidence requires overrides, each value
must receive a hard minimum and maximum at startup before entering the service.

### 4.4 Destination policy

The validator accepts absolute `https:` URLs and, when the operator flag is on,
absolute `http:` URLs. It rejects:

- embedded usernames or passwords;
- unsupported schemes;
- missing or malformed hosts;
- `localhost` and its subdomains;
- metadata host aliases;
- IPv4 and IPv6 loopback, unspecified, private/unique-local, link-local,
  carrier-grade/shared, multicast, reserved, documentation, benchmarking, and
  other non-public ranges;
- IPv4-mapped IPv6 addresses that normalize into a blocked IPv4 range;
- known platform metadata addresses not fully covered by generic range
  classification.

Address classification is centralized and reused for literal hosts and DNS
answers.

### 4.5 DNS pinning and redirects

For each request hop:

1. Parse and validate the URL.
2. Resolve all host addresses through the injected resolver.
3. Reject the hop if resolution is empty, invalid, or contains an unsafe answer.
4. Give the validated address to the transport's connection lookup so the
   connection uses that address rather than performing a second independent
   resolution.
5. Request with automatic redirects disabled.
6. If the response is a redirect, resolve its `Location` against the current URL
   and repeat the entire process.

Redirect loops, missing locations, and redirect counts above the configured
maximum fail safely. A redirect may not downgrade to HTTP unless the operator
has enabled HTTP.

### 4.6 Bounded streaming and decoding

Responses are consumed incrementally. The service counts bytes before and after
decompression and aborts as soon as any limit is exceeded.

The policy bounds:

- connection establishment time;
- total wall-clock request time;
- redirect count;
- compressed response bytes;
- decoded response bytes;
- decompression expansion ratio;
- accepted content encodings;
- accepted MIME types.

The service supports only the content encodings explicitly handled by the
bounded decoder. Unknown encodings fail closed. A response body is converted to
text or JSON only after the bounded stream finishes successfully.

### 4.7 Content profiles

Call sites select a predefined profile rather than supplying arbitrary MIME
rules:

- **Feed/XML:** `application/rss+xml`, `application/atom+xml`,
  `application/xml`, `text/xml`, and `text/plain`.
- **JSON:** `application/json`, `text/json`, and structured `+json` types.
- **Website HTML:** `text/html`, `application/xhtml+xml`, and `text/plain`.

Profiles may tighten the shared byte limits but cannot loosen operator safety
policy. Missing or unrecognized content types fail closed with `mime_blocked`;
the service does not inspect or persist the rejected response body.

## 5. Dependency injection and application wiring

`buildApp` retains deterministic, network-free tests. It receives an optional
`safeFetch` dependency. Production constructs the real service from validated
operator policy; tests inject a fixture implementation.

Raw `fetcher` injection remains for trusted provider SDK boundaries, local
service clients, mail, analytics, and connector-fabric transport. Sprint 48 does
not route trusted, operator-configured service endpoints through the untrusted
URL policy because doing so would block intentional local development services.

The boundary is based on trust:

- **Untrusted or workspace-influenced destination:** `SafeFetchService`.
- **Fixed provider endpoint or operator-configured internal service:** existing
  typed client/fetch seam with its own authentication and tests.

## 6. Tenant isolation and transaction design

### 6.1 Resolve before write

Services accept the target `workspaceId` and resolve every supplied related ID
with a workspace predicate. They never fetch a related object globally and check
ownership after inserting another row.

The public result for a missing related object is the same whether:

- the UUID does not exist; or
- it exists in another workspace.

### 6.2 One transaction boundary

Signal creation owns one transaction that includes:

- the signal row;
- explicit or generated match rows that belong to the creation result;
- mirrored suggested persona/campaign projections;
- initial response/triage state.

Helpers used inside the operation accept the transaction-scoped database handle.
They do not open nested transactions or write through the outer database handle.
Errors escape the transaction and roll back every write.

### 6.3 Wider invariant audit

The audit is scoped to discovery and signal write paths plus shared helpers those
paths call. It does not attempt an unrelated repository-wide authorization
rewrite. Each finding receives:

- a workspace-scoped service check;
- a negative cross-workspace test;
- a database invariant only where the existing portable schema can express it
  cleanly.

## 7. Source PATCH transition design

Updating a source becomes a state transition, not a loose column patch:

1. Load the source inside its workspace.
2. Merge stored editable fields with the submitted partial update.
3. Parse the complete result through the canonical create/source rules.
4. Verify any referenced connection inside the workspace.
5. Derive runtime status from source type, mode, configuration, connection,
   provider capability, permission state, and archival state.
6. Recompute scheduling fields for the valid transition.
7. Persist once.

Validation or reference failures leave the source unchanged. The API rejects
unsupported source modes at the boundary instead of storing an inert source that
fails during a later worker run.

## 8. Error handling and observability

`SafeFetchError` carries a stable internal code and a redacted public message.
Expected codes include:

- `invalid_url`
- `scheme_blocked`
- `credentials_blocked`
- `destination_blocked`
- `dns_failed`
- `redirect_blocked`
- `redirect_limit`
- `connect_timeout`
- `total_timeout`
- `compressed_limit`
- `decoded_limit`
- `decompression_ratio`
- `encoding_blocked`
- `mime_blocked`
- `upstream_status`
- `transport_failed`

The code may be persisted for operator diagnosis. Public errors and discovery
source `lastError` text must not contain:

- resolved IP addresses;
- internal hostnames;
- response bodies;
- credentials;
- raw transport exceptions;
- redirect targets that failed private-destination checks.

Tests may inspect richer error causes directly in memory, but those causes are
never serialized into an API response or durable user-visible field.

## 9. Verification

### 9.1 Safe-fetch unit and adversarial tests

- Valid public HTTPS URL.
- HTTP rejected by default and accepted only with the operator flag.
- Embedded credentials rejected.
- Unsupported schemes rejected.
- IPv4 loopback, private, link-local, carrier-grade, multicast, reserved,
  documentation, and metadata addresses rejected.
- IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation,
  and IPv4-mapped blocked addresses rejected.
- Hostname resolving to an unsafe address rejected.
- Mixed safe and unsafe DNS answers rejected.
- Connection pinned to the validated address.
- Redirect to an unsafe destination rejected.
- Redirect loop and limit rejected.
- Protocol downgrade rejected unless HTTP is enabled.
- Connect and total timeouts abort.
- Compressed and decoded byte limits abort while streaming.
- Excessive decompression ratio aborts.
- Unexpected MIME and content encoding rejected.
- Safe errors contain no internal response content.

### 9.2 Integration regressions

- Every keyless discovery source continues to parse its existing fixture.
- RSS and podcast sources pointing at metadata addresses fail at create time and
  at fetch time.
- Website scraping still follows same-origin relevant links through safe fetch.
- Oversized or compressed malicious fixtures terminate within the configured
  bound.
- Unknown and foreign persona/campaign IDs return the same `404`.
- Fault injection during signal creation leaves no signal or match row.
- Valid source patches derive the expected status and schedule.
- Invalid merged source patches return an error and preserve the stored source.

### 9.3 Completion commands

Each card runs its focused test file(s) and `npm run typecheck`. Before the sprint
epic is complete:

```sh
npm run typecheck
npm test
```

The founder acceptance evidence for TAP-7 includes the three PRD cases:

1. Foreign persona signal creation returns `404` and persists nothing.
2. `http://169.254.169.254/` is rejected at source creation and at fetch time.
3. A gzip-bomb fixture terminates at the configured byte/ratio bound.

## 10. Plane status protocol

- Implementation reads the full card and comments immediately before starting it.
- A child card is moved to `Done` only after its focused verification passes.
- The completion comment records the implementation summary, test commands,
  result counts, and commit SHA.
- If a card cannot meet its acceptance criteria, it remains unfinished and the
  blocker is recorded without claiming completion.
- TAP-7 is moved to `In Progress` after the first child card completes.
- TAP-7 is moved to `Done` only after all nine child cards are done and the full
  sprint verification passes.
- No Sprint 49 work begins until Sprint 48 receives founder acceptance, per
  `CLAUDE.md`.

## 11. Non-goals

- Changing provider availability or repairing LinkedIn, Google Trends, Instagram,
  or deduplication behavior; those belong to Sprint 50.
- Replacing trusted connector, LLM, mail, analytics, or internal-service clients
  with the untrusted safe-fetch policy.
- A workspace UI for weakening network policy.
- A general repository-wide authorization rewrite.
- New discovery source types or customer-visible features.

## 12. Progress log

- **2026-07-28:** Plane TAP-7 and all nine child cards inspected.
- **2026-07-28:** Founder approved operator-only HTTP opt-in and the guarded
  networking behavior.
- **2026-07-28:** Founder approved sequential card delivery and verification
  gates.
- **2026-07-28:** Isolated branch created from `main` at `03329c4`.
- **2026-07-28:** Clean baseline confirmed: 162 test files and 1,520 tests pass
  after installing the missing Playwright Chromium test binary.
- **2026-07-28:** All nine implementation cards completed and confirmed `Done`
  in Plane: TAP-35 `aa2487c`, TAP-36 `cab7d97`, TAP-37 `10a97d5`, TAP-38
  `ddbb198`, TAP-39 `db83e8f`, TAP-40 `b0ae203`, TAP-41 `4846c1e`, TAP-42
  `a957e15`, and TAP-43 `441fff7`.
- **2026-07-28:** Founder acceptance regressions passed: foreign references 4/4,
  metadata-address create/fetch 2/2, and gzip-bomb bounds 1/1.
- **2026-07-28:** Release verification passed across all seven workspaces:
  `npm run typecheck` succeeded and `npm test` passed 165 test files with 1,715
  tests.
- **2026-07-28:** Delegated founder-acceptance audit found and closed two gaps:
  connected-provider permission errors no longer expose upstream response
  bodies, and discovery scoring now revalidates tenant references and triage
  state inside an atomic transaction.
- **2026-07-28:** Four new adversarial regressions cover permission-payload
  redaction, a campaign leaving the workspace during scoring, acceptance
  racing an in-flight judgment, and rollback after a partial match-write
  fault. The affected discovery suites passed 72/72 tests.
- **2026-07-28:** Final independent re-review reported no remaining findings.
  The complete post-fix gate passed all seven workspace typechecks and 165 test
  files with 1,718/1,718 tests.
