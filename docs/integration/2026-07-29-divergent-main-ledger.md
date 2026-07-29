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

| Commit | Integration task | Initial disposition |
|---|---|---|
| `03329c4` | Replay local documentation history | planned replay |
| `e1ee8b5` | Replay local documentation history | planned replay |
| `310284c` | Replay local documentation history | planned replay |
| `aa2487c` | Integrate safe-fetch foundation | planned replay |
| `cab7d97` | Integrate safe-fetch foundation | planned replay |
| `10a97d5` | Integrate safe-fetch foundation | planned replay |
| `ddbb198` | Integrate safe-fetch foundation | planned replay |
| `db83e8f` | Integrate tenant isolation and guarded discovery | planned replay |
| `b0ae203` | Integrate tenant isolation and guarded discovery | planned replay |
| `4846c1e` | Integrate tenant isolation and guarded discovery | planned replay |
| `a957e15` | Integrate tenant isolation and guarded discovery | planned replay |
| `441fff7` | Integrate tenant isolation and guarded discovery | planned replay |
| `6f9a839` | Integrate tenant isolation and guarded discovery | planned replay |
| `d9717aa` | Integrate tenant isolation and guarded discovery | planned replay |
| `15d4bd8` | Replay local documentation history | planned replay |
| `6a78150` | Replay local documentation history | planned replay |
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
