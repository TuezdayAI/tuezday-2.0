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
| `db83e8f` | Integrate tenant isolation and guarded discovery | planned replay |
| `b0ae203` | Integrate tenant isolation and guarded discovery | planned replay |
| `4846c1e` | Integrate tenant isolation and guarded discovery | planned replay |
| `a957e15` | Integrate tenant isolation and guarded discovery | planned replay |
| `441fff7` | Integrate tenant isolation and guarded discovery | planned replay |
| `6f9a839` | Integrate tenant isolation and guarded discovery | planned replay |
| `d9717aa` | Integrate tenant isolation and guarded discovery | planned replay |
| `15d4bd8` | Replay local documentation history | replayed as `77115df` |
| `6a78150` | Replay local documentation history | replayed as `0951636` |
| `96da3a3` | Regenerate lease persistence as migration 0053 | planned replay |
| `7584eab` | Regenerate lease persistence as migration 0053 | planned replay |
| `1679852` | Combine execution bounds, LLM gateway, and native evidence | planned replay |
| `7ce5487` | Combine execution bounds, LLM gateway, and native evidence | planned replay |
| `2ea63c5` | Regenerate automation idempotency as migration 0054 | planned replay |
| `f182c8e` | Regenerate matching state as migration 0055 | planned replay |
| `cf58135` | Regenerate matching state as migration 0055 | planned replay |
| `e6b5a2f` | Regenerate matching state as migration 0055 | planned replay |
| `f01dd67` | Integrate scoped worker auth and managed scheduling | planned replay |
| `5221dbd` | Regenerate matching state as migration 0055 | planned replay |
| `555350d` | Reconcile UI, manifests, environment, and documentation | planned replay |
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
