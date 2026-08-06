# GitHub protection setup

Goal: make the CLAUDE.md workflow physically enforced, not requested. Nobody — human or agent — can push to `main`, merge unreviewed, or merge red CI.

Do this once. 20 minutes.

---

## 1. Repo settings (Settings → General)

- **Pull Requests**
  - Allow squash merging — ON. Allow merge commits — OFF. Allow rebase — OFF.
    (One commit per sprint on `main`. Clean history, easy revert.)
  - Default squash commit message: **Pull request title and description**
  - Automatically delete head branches — ON
  - Allow auto-merge — OFF (you want to press the button yourself)
- **Settings → Actions → General → Workflow permissions**
  - Read repository contents — selected. "Allow GitHub Actions to create and approve pull requests" — OFF.
    (Stops an agent-triggered workflow from approving its own PR.)
- **Settings → Code security**
  - Secret scanning — ON. **Push protection — ON.**
    (Blocks a leaked `GEMINI_API_KEY` at the push, not at the postmortem.)
  - Dependabot alerts — ON.

## 2. CODEOWNERS

Create `.github/CODEOWNERS` on `main`:

```
# Founder owns everything by default.
*                                   @FOUNDER_GITHUB_HANDLE

# Blast-radius surfaces — never merged without founder eyes.
/packages/contracts/                @FOUNDER_GITHUB_HANDLE
/apps/api/src/db/schema.ts          @FOUNDER_GITHUB_HANDLE
/apps/api/src/app.ts                @FOUNDER_GITHUB_HANDLE
/apps/api/src/auth/                 @FOUNDER_GITHUB_HANDLE
/apps/api/drizzle/                  @FOUNDER_GITHUB_HANDLE
/.github/                           @FOUNDER_GITHUB_HANDLE
/.claude/                           @FOUNDER_GITHUB_HANDLE
/CLAUDE.md                          @FOUNDER_GITHUB_HANDLE
```

The last four lines matter most: they stop anyone (or anyone's agent) from quietly weakening the guardrails in the same PR that needed them.

## 3. Ruleset: protect `main`

Settings → Rules → Rulesets → New ruleset → New branch ruleset.

- **Name:** `protect-main`
- **Enforcement status:** Active
- **Bypass list:** empty. <cite>If admins can bypass your rules, the rules are a false sense of security</cite> — leave it empty and turn on "Do not allow bypassing the above settings" if you use the legacy UI.
- **Target branches:** Include default branch

Rules to enable:

| Rule | Setting |
|---|---|
| Restrict deletions | ON |
| Block force pushes | ON |
| Require linear history | ON |
| Require a pull request before merging | ON |
| → Required approvals | **1** |
| → Dismiss stale approvals when new commits are pushed | ON |
| → Require review from Code Owners | ON |
| → Require approval of the most recent reviewable push | ON |
| → Require conversation resolution before merging | ON |
| Require status checks to pass | ON |
| → Require branches to be up to date before merging | ON |
| → Required check | your CI job name (see §5) |
| Require signed commits | Optional — turn on once everyone has GPG/SSH signing set up |

Why each of the review sub-settings: without stale-approval dismissal, someone can get approval, push a breaking change, and merge. "Approval of the most recent reviewable push" stops a PR author from approving their own last commit.

## 4. Ruleset: enforce sprint branch naming

Second ruleset, `sprint-branch-naming`, targeting `refs/heads/sprint-*`:

- **Restrict branch names** (metadata restriction) — must match:
  `^sprint-\d{2}-[a-z0-9-]+\n?$`
- Block force pushes — ON

<cite>When using end-of-line anchors in ruleset regexes, use `\n?$` rather than `$` alone</cite> — a trailing newline appears in CLI push flows and will otherwise cause confusing failures.

This makes `sprint-NN-<slug>` mechanical instead of a convention people drift from.

## 5. Make CI a real gate

Your workflow must trigger on `pull_request`, or the required check never runs and PRs are permanently stuck:

```yaml
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:                      # <- this name is what you type in the ruleset
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run graph:check
      - run: npm test
```

Two gotchas:
- **Job names must be unique across all workflows.** Reusing a job name in two workflows produces ambiguous check results and blocks merges.
- A required check only appears in the merge checklist when it runs against the PR's head commit. One job named `ci` running four steps is simpler and more reliable than four separately-required checks.

## 6. Import instead of clicking (optional)

Rulesets export/import as JSON. Use the companion `ruleset-protect-main.json`:

```bash
gh api repos/OWNER/REPO/rulesets \
  --method POST \
  --input ruleset-protect-main.json
```

Keep that JSON in the repo so the config is reviewable and restorable.

---

## The one trade-off to decide

With `required approvals: 1` and CODEOWNERS pointing only at you, **you cannot merge your own PRs** — GitHub won't let an author approve their own pull request. Three options:

1. **Add a second CODEOWNER** (your most senior engineer) for non-critical paths, keeping yourself sole owner on `packages/contracts`, schema, auth, and `.github`/`.claude`. Recommended.
2. **Add yourself to the ruleset bypass list.** Simplest, but reintroduces exactly the hole this is meant to close.
3. Push your own work through a teammate's review too. Slowest, strictest.

## What this buys you against the "new hire tomorrow" risk

- Their agent physically cannot push to `main`.
- Their agent cannot merge red CI — lint, typecheck, dependency boundaries, and tests all block.
- Their agent cannot touch contracts, schema, auth, or the guardrail files without your explicit approval.
- Their agent cannot leak a key past push protection.
- Force-push and branch deletion are off, so nothing is unrecoverable.

Layer 1 (CLAUDE.md) tells the agent what good looks like. Layer 2 (hooks) catches mistakes as they happen. Layer 3 (this) means the mistakes that slip through both still never reach `main`.
