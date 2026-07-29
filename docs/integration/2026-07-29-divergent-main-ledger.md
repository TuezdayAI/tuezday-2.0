# Divergent Main Reconciliation Ledger

## Protected sources

- Remote baseline: `a2b55231ebe38b9491151cd92928b521d22fed76`
- Local source: `48a47c6800d1a77b176ad2e4d126fa2bf5b0af00`
- Common ancestor: `cb18bf1494eac4a111ca4376f7293d38419effcc`
- Integration branch: `integration/remote-main-local-s48-s49`
- Protected-source verification: `2026-07-29` — exact hashes confirmed after
  `git fetch origin --prune`; isolated worktree clean.

## Plane task map

| Plane item | Integration task | Status at baseline |
|---|---|---|
| `TAP-123` | Integrate divergent local and remote main histories | In Progress |
| `TAP-124` | Record integration baseline and source ledger | In Progress |
| `TAP-125` | Replay local documentation history | Todo |
| `TAP-126` | Integrate safe-fetch foundation | Todo |
| `TAP-127` | Integrate tenant isolation and guarded discovery | Todo |
| `TAP-128` | Regenerate lease persistence as migration 0053 | Todo |
| `TAP-129` | Combine execution bounds, LLM gateway, and native evidence | Todo |
| `TAP-130` | Regenerate automation idempotency as migration 0054 | Todo |
| `TAP-131` | Regenerate matching state as migration 0055 | Todo |
| `TAP-132` | Integrate scoped worker auth and managed scheduling | Todo |
| `TAP-133` | Reconcile UI, manifests, environment, and documentation | Todo |
| `TAP-134` | Run cross-history acceptance | Todo |
| `TAP-135` | Verify, review, and publish the integration branch | Todo |

## Migration map

| Discarded local file | Canonical output | Disposition |
|---|---|---|
| `0048_sprint_49_leases.sql` | `0053_sprint_49_leases.sql` | regenerate after remote `0052` |
| `0049_sprint_49_automation_idempotency.sql` | `0054_sprint_49_automation_idempotency.sql` | regenerate after `0053` |
| `0050_sprint_49_matching_state.sql` | `0055_sprint_49_matching_state.sql` | regenerate after `0054` |

## Commit disposition

| Commit | Integration task | Disposition |
|---|---|---|
| `03329c4` | Replay local documentation history | replayed as `83416e7` |
| `e1ee8b5` | Replay local documentation history | replayed as `abeff1f` |
| `310284c` | Replay local documentation history | replayed as `b38dd83` |
| `aa2487c` | Integrate safe-fetch foundation | replayed as `39d6c8e` |
| `cab7d97` | Integrate safe-fetch foundation | replayed as `8c86500` |
| `10a97d5` | Integrate safe-fetch foundation | replayed as `6574a29` |
| `ddbb198` | Integrate safe-fetch foundation | replayed as `372b8c4` |
| `db83e8f` | Integrate tenant isolation and guarded discovery | replayed as `8f7ef79` |
| `b0ae203` | Integrate tenant isolation and guarded discovery | replayed as `1688566` |
| `4846c1e` | Integrate tenant isolation and guarded discovery | replayed as `05a65ac` |
| `a957e15` | Integrate tenant isolation and guarded discovery | replayed as `bfd4aba` |
| `441fff7` | Integrate tenant isolation and guarded discovery | replayed as `8e00756` |
| `6f9a839` | Integrate tenant isolation and guarded discovery | replayed as `78cc328` |
| `d9717aa` | Integrate tenant isolation and guarded discovery | replayed as `a5a6f92` |
| `15d4bd8` | Replay local documentation history | replayed as `77115df` |
| `6a78150` | Replay local documentation history | replayed as `0951636` |
| `96da3a3` | Regenerate lease persistence as migration 0053 | replayed as `71711e3` |
| `7584eab` | Regenerate lease persistence as migration 0053 | replayed as `d54ab36` |
| `1679852` | Combine execution bounds, LLM gateway, and native evidence | replayed as `b949992` |
| `7ce5487` | Combine execution bounds, LLM gateway, and native evidence | replayed as `f57bd60` |
| `2ea63c5` | Regenerate automation idempotency as migration 0054 | replayed as `df5ca76` |
| `f182c8e` | Regenerate matching state as migration 0055 | replayed as `2136157` |
| `cf58135` | Regenerate matching state as migration 0055 | replayed as `cb5e63b` |
| `e6b5a2f` | Regenerate matching state as migration 0055 | replayed as `7567576` |
| `f01dd67` | Integrate scoped worker auth and managed scheduling | replayed as `163d3f2` |
| `5221dbd` | Regenerate matching state as migration 0055 | replayed as `0ac0964` |
| `555350d` | Reconcile UI, manifests, environment, and documentation | replayed as `57d1715` |
| `5c712c9` | Run cross-history acceptance | planned replay |
| `48a47c6` | Verify, review, and publish the integration branch | superseded by the new integration branch |

## Verification evidence

Append one dated entry per task with Plane item, commands, result, and commit.

### 2026-07-29 — TAP-124 — Record integration baseline and source ledger

- Plane parent: `TAP-123` (`In Progress`)
- Plane child: `TAP-124` (`In Progress` while this evidence was recorded)
- Source protection:
  - `git fetch origin --prune` — passed
  - `git status --short` — clean before creating this ledger
  - `git rev-parse origin/main` —
    `a2b55231ebe38b9491151cd92928b521d22fed76`
  - `git rev-parse main` —
    `48a47c6800d1a77b176ad2e4d126fa2bf5b0af00`
  - `git merge-base main origin/main` —
    `cb18bf1494eac4a111ca4376f7293d38419effcc`
  - `git branch --show-current` —
    `integration/remote-main-local-s48-s49`
- Baseline:
  - `npm ci` — passed; 386 packages installed and 394 packages audited.
    Existing audit output: 19 vulnerabilities (1 low, 8 moderate, 8 high,
    2 critical).
  - `npm run typecheck` — passed for API, MCP, web, worker, brain, contracts,
    and testing workspaces.
  - `npm test` — passed: 168 test files and 1,597 tests.
  - `npm run build` — passed: MCP TypeScript build and Next.js 15.5.19
    production build. Next.js emitted the inherited multiple-lockfile
    workspace-root warning.
- Baseline evidence commit:
  `22a64ce7d7d51ab084e5bbb04768b06dc4803d42`

### 2026-07-29 — TAP-125 — Replay local documentation history

- Source commits and replay results:
  - `03329c4644375f312c8ae57e1efeb4338e96400e` →
    `83416e7650781300ea90b9e7913d0f55438d9715`
  - `e1ee8b507774e8a804ef8f427ae34cf2a4f871c6` →
    `abeff1f507d9f4e7a1262ff3ef55287949f73fae`
  - `310284c4d383f0532117b0d2191dc305104c671f` →
    `b38dd83dabc8aa7ccf458da5bd6e6a12ccbb19ce`
  - `15d4bd8788d7743e9e4b40ef5d2dbafede740afc` →
    `77115dfc651599cef9b20f6c16fb2bba11cbb242`
  - `6a78150e3f50c12219000b8dabb84855647d423e` →
    `0951636d69a209a31cda37da4f866aa63d456491`
- `git cherry-pick <five documentation commits>` — passed without conflicts.
- `git diff --check origin/main...HEAD` — passed.
- `rg -n "R2R|native evidence|safe-fetch|bounded leased" ...` — passed;
  the five local documents are present. Historical R2R descriptions remain
  historical; the approved integration design states that native evidence
  owns the integrated runtime.

### 2026-07-29 — TAP-126 — Integrate safe-fetch foundation

- Source commits and replay results:
  - `aa2487c` → `39d6c8e29b2280bc3c44968c666a9ca7774065c8`
  - `cab7d97` → `8c86500470679e1fdc36cea0cb708938ce8f6fbe`
  - `10a97d5` → `6574a29221ef32ea3a8242d59049b82afbe112bf`
  - `ddbb198` → `372b8c460f40ce0a11ff497031656924c9b06cee`
- `git cherry-pick aa2487c cab7d97 10a97d5 ddbb198` — passed without
  conflicts.
- Dependency union confirmed in the API manifest and lockfile:
  `ipaddr.js@^2.4.0`, `sqlite-vec@^0.1.9`, and `undici@^6.28.0`.
- `npm install --package-lock-only --ignore-scripts` — passed. It produced
  only unrelated npm-version peer-flag churn after the replayed lockfile was
  already current, so that incidental metadata diff was discarded.
- `npm ci` — passed; 387 packages installed and 395 audited. The inherited
  audit baseline remained 19 vulnerabilities.
- Focused safe-fetch gate — passed: 3 test files and 156 tests.
- `npm run typecheck -w apps/api` — passed.

### 2026-07-29 — TAP-127 — Integrate tenant isolation and guarded discovery

- Source commits and replay results:
  - `db83e8f` → `8f7ef79`
  - `b0ae203` → `1688566`
  - `4846c1e` → `05a65ac`
  - `a957e15` → `bfd4aba`
  - `441fff7` → `8e00756`
  - `6f9a839` → `78cc328`
  - `d9717aa` → `a5a6f92`
- `apps/api/src/app.ts` was the only conflict. The resolution keeps:
  - `TrustedFetcher` for Nango, Gmail/Resend, analytics, webhooks, and other
    trusted provider seams;
  - `SafeFetchService` for discovery and workspace/brand website scraping;
  - `DbEvidenceStore(db, llm)` as the native evidence default;
  - the remote Gmail, outreach, compliance, tracking, and 4,096-character
    tracking-token route support.
- Remaining six commits replayed without conflicts.
- Security and remote-regression gate — passed: 13 test files and 366 tests.
- `npm run typecheck -w apps/api` — passed.

### 2026-07-29 — TAP-128 — Regenerate lease persistence as migration 0053

- `96da3a3` → `71711e3dd8e34046714f55fe5ba8221944c6b1a3`
- `7584eab` → `d54ab360d21f6d22a6abdcce74967f86fd2773dc`
- Discarded `0048_sprint_49_leases.sql` and its local snapshot/journal
  lineage; remote migrations `0048`–`0052` remain unchanged.
- Replaced the legacy-database repair test with the approved
  disposable-database assertion over every numbered migration.
- Red gate: `sprint49-migrations.test.ts` failed because no `0053` migration
  existed.
- Generated `0053_sprint_49_leases.sql` and `0053_snapshot.json`.
  The snapshot `prevId` equals the remote `0052_snapshot.json` ID, and the
  journal entry is index 53 with tag `0053_sprint_49_leases`.
- Green lease gate — passed: 4 test files and 58 tests.
- `npm run typecheck -w apps/api` — passed.

### 2026-07-29 — TAP-129 — Combine execution bounds, LLM, and evidence

- `1679852` → `b94999227fe15ddc85c8c889df4c6123262148da`
- `7ce5487` → `f57bd60517f9e2e976a3e1d343b64f8b3c4f69fe`
- Added the cancellation-plus-embedding regression before replay.
  - Red: generation ignored the aborted signal and returned
    `Gemini API returned an empty response`.
  - Green after gateway replay: 2 files and 28 tests passed.
- The gateway union keeps `GenerateParams.signal`, `EmbedParams`,
  `EmbedResult`, and optional `LlmGateway.embed()`. Gemini keeps embeddings
  and abort-aware generation; OpenRouter remains generation-only.
- `app.ts`/`server.ts` resolution keeps one environment-selected
  `LlmGateway`, shares it with `DbEvidenceStore`, retains the remote Gmail,
  outreach, tracking, and 4,096-character tracking-token support, and adds
  bounded discovery policy plus shutdown signaling.
- Composition and bounds gate — passed: 11 test files and 228 tests.
- `npm run typecheck -w apps/api` — passed.
- R2R runtime/script scan — passed with zero matches.

### 2026-07-29 — TAP-130 — Regenerate automation idempotency as 0054

- `2ea63c5` → `df5ca7657c9d43e56221c82a977fae128581103f`
- Discarded the local `0049_sprint_49_automation_idempotency.sql`
  artifact and restored the canonical remote `0049` snapshot before
  generation.
- Red gate: the existing `0053` migration assertion passed and the new
  automation-idempotency assertion failed only because no `0054` file
  existed.
- Generated `0054_sprint_49_automation_idempotency.sql` and
  `0054_snapshot.json`. The migration adds nullable `drafts.automation_key`
  plus the partial unique `drafts_automation_key` index; its snapshot points
  to `0053`.
- Idempotency gate — passed: 4 test files and 45 tests.
- `npm run typecheck -w apps/api` — passed.

### 2026-07-29 — TAP-131 — Regenerate matching state as 0055

- Source commits and replay results:
  - `f182c8e` → `21361570b9f5d16bedae2da384c3cf1bf695416c`
  - `cf58135` → `cb5e63b2675122b05879a22bbcdc75b3943b12d3`
  - `e6b5a2f` → `75675761f976e63ca90644e4a38be6b0ed3ead37`
  - `5221dbd` → `0ac0964198d46d1980294017959d0ee3dce89e3d`
- Discarded local `0050_sprint_49_matching_state.sql`; the remote `0050`
  snapshot and all earlier remote migrations remain canonical.
- Red gate: `0053` and `0054` assertions passed; matching claims failed only
  because no `0055` migration existed.
- Generated `0055_sprint_49_matching_state.sql` and `0055_snapshot.json`.
  It adds versioned matching claims, fingerprint/lease/error fields, and the
  matching queue index; its snapshot points to `0054`.
- Matching/cursor/invalidation gate — passed: 9 test files and 253 tests,
  including 154 existing contracts tests and 8 outbound-email tests.
- `npm run typecheck -w apps/api` — passed.
- `npm run typecheck -w packages/contracts` — passed.

### 2026-07-29 — TAP-132 — Integrate scoped worker auth and scheduling

- `f01dd67` → `163d3f2`
- Used the local managed-worker implementation as the conflict base, then
  ported the remote mailbox-inbox and outreach jobs into `startSettledLoop`.
- Red config gate: 5 assertions failed because `mailboxInboxMs` and
  `outreachMs` were missing. Green config gate: 34 tests passed after adding
  both parsed, bounded intervals.
- Authentication union:
  - `/t/o/:token` and `/t/c/:token` remain public and reach signed-token
    validation without session authentication;
  - `/internal/*` remains exact-worker-token-only;
  - the worker token can call only the explicit maintenance allowlist,
    including mailbox-inbox and outreach.
- `npm install --package-lock-only --ignore-scripts` and `npm ci` — passed;
  incidental npm-version peer-flag churn was discarded while the worker
  Vitest dependency change remained.
- Auth/worker gate — passed: 9 test files and 145 tests.
- `npm run typecheck -w apps/api` — passed.
- `npm run typecheck -w apps/worker` — passed.
- Worker `setInterval` scan — passed with zero matches.

### 2026-07-29 — TAP-133 — Reconcile UI, environment, and documentation

- `555350d` → `57d1715d9146ed09794d72597fd8d236ae4a8b9a`
- Resolved the founder-acceptance conflict as a union: native evidence and the
  Gmail/outreach/compliance/tracking path remain covered alongside local
  safe-fetch, tenant-isolation, and bounded-execution acceptance.
- The discovery UI now distinguishes busy and safety-limited runs, surfaces
  scoring readiness in founder language, disables acceptance until matching is
  ready, and preserves the server's stable readiness error.
- `.env.example`, `README.md`, and `CLAUDE.md` document the operator-only
  discovery policy, required API/worker topology, scoped internal URL/token,
  complete scheduled loop set, and native evidence migration/parity path.
- `npm install --package-lock-only --ignore-scripts` and `npm ci` — passed;
  incidental npm-version peer-flag churn was discarded.
- Focused UI/contracts/outreach gate — passed: 6 test files and 207 tests.
- `npm run typecheck -w apps/web` — passed.
- `npm run typecheck -w packages/contracts` — passed.
- R2R runtime/script scan — passed with zero active references.
