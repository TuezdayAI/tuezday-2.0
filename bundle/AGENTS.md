# AGENTS.md

Canonical rulebook for every coding agent on this repo (Claude Code, Codex, Cursor, or human). Claude Code reads this via `CLAUDE.md`; Codex and Cursor read this file directly.

Tuezday is an AI-powered GTM orchestration platform. TypeScript monorepo (npm workspaces, Node ≥ 20, ESM, no build step in dev).

**Read this fully before your first edit in a session. If a rule here conflicts with a habit you have, this file wins. If it conflicts with a spec, ask.**

---

## 1. Commands

```bash
npm install                      # install all workspaces
npm run dev                      # API :3001 + web :3000 + worker
npm run dev:app                  # API + web only (no background work)
npm test                         # all Vitest suites (in-memory SQLite + real migrations)
npm test -- <substring>          # filter by path, e.g. npm test -- brain
npm run typecheck                # tsc --noEmit, all workspaces
npm run lint                     # Biome check (must be clean)
npm run lint:fix                 # Biome autofix
npm run graph                    # regenerate docs/agent/dependency-map.md (see §7)
npm run graph:check              # fail on circular deps / illegal imports
npm run db:generate -w apps/api  # Drizzle migration after editing schema.ts
```

Before you say a task is done: `npm run lint && npm run typecheck && npm test` must all pass. No exceptions, no "should be fine".

Git hooks run these automatically on commit and push. **Never use `--no-verify`.** If a hook blocks you, the hook is right.

## 2. Architecture in one screen

```
apps/api      Fastify. routes -> services -> db. Composition root: src/app.ts
apps/web      Next.js App Router
apps/worker   Thin loop runner. Calls the API. Never touches the DB directly.
packages/brain      Context Resolver
packages/contracts  Zod schemas + ALL enum vocabularies + state machines
```

Non-negotiable structural rules:

- **Routes are thin.** Validate with a `packages/contracts` schema, then call a service. Zero business logic, zero DB access in a route.
- **All DB access lives in `apps/api/src/db` and services.** Keep the schema Postgres-portable.
- **Every external dependency is an injectable option on `buildApp()` with a real default.** Tests must never hit the network.
- **Integrations live behind interfaces.** `LlmGateway`, `EvidenceStore`, `ConnectorFabric`, `Fetcher`, `Mailer`. Provider code never leaks into a service.
- **Enums are declared once**, in `packages/contracts`. Import them. Never redeclare a union of strings that already exists there.
- **State transitions use `transitionTo()` / `canTransition()`** (and `canTransitionExternalAction()` for external actions). Never write bespoke transition logic.
- **`OutboundExporter` is a manual CSV export, not a send path.** No dispatch code may call it.

Deeper context, read only when the task needs it:
- `docs/agent/architecture.md` — seams, auth model, actor resolution, worker contract
- `docs/agent/product.md` — brain docs, overlays, approval gate, learning loop
- `docs/agent/integrations.md` — build-native vs integrate boundaries
- `docs/agent/dependency-map.md` — generated module graph (§7)
- `docs/agent/github-protection.md` — branch rules; `main` is protected
- `docs/specs/` — one spec per slice

## 3. Code style

Biome owns formatting and lint. Do not argue with it, do not hand-format, do not add style comments. These are the rules Biome cannot enforce:

- **Write the simplest thing that passes the test.** No speculative abstractions, no config options nobody asked for, no interface with one implementation and one caller, no "we might need this later".
- **No new npm dependency without asking first.** If the answer is 20 lines of code, write the 20 lines.
- **Comments explain *why*, never *what*.** Delete any comment that restates the line under it.
- **No `console.log` in committed code.** Use the existing logger.
- **No dead code, no commented-out blocks, no `any` escape hatches.** If you need `any`, stop and ask.
- **Stay inside the slice.** Do not opportunistically refactor unrelated files. Unrelated improvements go in a note at the end of your message, not in the diff.
- **Soft ceilings:** ~40 lines per function, ~300 per file. Exceeding either is a signal to split, not a rule to break silently.
- **Errors are handled explicitly.** No empty catch blocks, no swallowing.
- Follow the surrounding file's existing patterns over your own preferences.

## 4. Output discipline

You are writing code, not documentation about code.

- **Never create README, summary, notes, or `*.md` files unless explicitly asked.** The only markdown you write unprompted is the sprint spec in `docs/specs/`.
- **Commit messages: one line, imperative, plus the trailer** `Co-Authored-By: <your agent name>`. No bullet-point essays.
- **Report results in this shape and nothing more:** what changed (files), what passed (checks), what needs a decision. No step-by-step recaps, no praise, no restating the request back.
- **Do not narrate your plan** unless the task is ambiguous enough to need confirmation first.

## 5. Testing rules

- Tests come with (or before) the implementation. Follow `apps/api/test/helpers.ts`: `createTestDb()`, `buildAuthedApp()`, drive with `app.inject()`, assert against contracts schemas. One test file per slice.
- **Never skip, delete, weaken, or loosen a test to make the suite green.** No `.skip`, no `.only`, no relaxing a zod schema to fit a broken response. A failing test is information — stop and ask.
- **Never mock the thing under test.** Inject fakes at the seams, not inside the service you're verifying.
- If you change behaviour, the test change must be visible and explained in one line.

## 6. Frontend rules (`apps/web`)

- Design decisions come from the shared design skill at `.agents/skills/tuezday-design/SKILL.md`. Read it before building UI. It is the source of truth for tokens, spacing, typography, and component patterns — not your defaults.
- **Every async view ships loading, empty, and error states.** A view with only a happy path is unfinished.
- Keyboard reachable, visible focus states, labelled inputs. Not optional.
- **After any UI change, render it and look at it** before declaring done. Compiling is not verifying.
- **Audit changed UI against the Web Interface Guidelines before pushing** (see §12). Fix what it flags or explain why not.
- No new component library, CSS framework, or icon set without asking.

## 7. Dependency awareness — read before editing shared code

Assume you cannot see the whole graph. You will miss callers unless you look them up. **Grep answers "where is this text"; it does not answer "what breaks if I change this".**

Before editing anything in `packages/contracts`, `apps/api/src/db/schema.ts`, `app.ts`, any `services/*`, or any interface named in §2:

1. Run `npm run graph` and read the importers of the file you're about to touch in `docs/agent/dependency-map.md`.
2. Grep for every call site of the symbol you're changing, across **all** workspaces including `apps/worker` and tests.
3. State the blast radius in one line before you edit: *"Changing `approvalStates` — 7 importers across api services, web, worker."*
4. If the blast radius crosses more than one slice, **stop and ask** before proceeding.
5. After the edit, `npm run graph:check` must pass — it fails on circular dependencies and on illegal imports (e.g. web importing from `apps/api/src`, worker touching db, provider code inside services).

Rules that follow from this:
- **Never rename or move a shared symbol as a side effect** of another task.
- **Never change a zod contract without checking both producers and consumers.**
- **Never hand-write migration SQL.** Edit `schema.ts`, then `npm run db:generate`.
- A schema change is a cross-slice change by definition. Treat it as step 4.

## 8. When to stop and ask

Stop and ask the human — do not guess — when:

- The spec is ambiguous, or reality contradicts it.
- The change touches `packages/contracts`, the auth guard, the DB schema, or an accepted (frozen) slice.
- The blast radius crosses slices (§7.4).
- A test fails in a way that suggests the test is wrong.
- You'd need a new dependency, a new pattern, or a new integration.
- You've tried the same fix twice and it hasn't worked.

Guessing costs the team more than asking. There is no penalty for asking.

## 9. Sprint delivery workflow (Sprints 21+)

1. Branch from `main`: `sprint-NN-<slug>` (enforced by a GitHub ruleset). If "Builds on" names an unmerged 21+ sprint, branch off that instead and say so at the top of the spec.
2. **Write `docs/specs/sprint-NN-*.md` first** (spec + step-by-step plan + progress log) and ask clarifying questions before implementing. Sessions reset between sprints — the spec must stand alone.
3. Tests with/before implementation.
4. Gate: `npm run lint && npm run typecheck && npm run graph:check && npm test` green, plus a UI audit on any changed frontend.
5. Self-review the full diff before pushing (see §12 for the review tooling your agent has).
6. Push the branch (`git push -u origin sprint-NN-<slug>`).
7. **`main` is protected.** You cannot push to it, force-push, or merge. Open a PR; the founder reviews and merges. Never edit `.github/`, `.agents/`, `.claude/`, `lefthook.yml`, or this file as a side effect of a sprint.
8. One sprint at a time. Do not start the next until asked.

## 10. Build order (do not skip ahead)

Foundation → Central Brain → Context Resolver → Generation Sandbox → Approval Gate → Manual Content → Campaigns → RAG → Discovery → Learning Loop → Outbound → Connector Fabric → CRM/Ads/Lifecycle.

One vertical slice at a time: spec → tests → build → verify → founder accepts → frozen. No new slice until the previous is accepted. No module depends on a fake brain contract. Every slice produces something a human can see and test.

## 11. Environment

Copy `.env.example` to `.env` at the repo root. Required: `GEMINI_API_KEY`, `TUEZDAY_WORKER_TOKEN`, `TUEZDAY_INTERNAL_API_URL` (worker→API origin; HTTPS in prod, loopback HTTP locally — never point it at the browser/MCP gateway). Connector creds are per-sprint; leave blank until wired.

**Never write to `.env`, never print a secret, never commit a key.** A pre-commit hook and GitHub push protection both block this — if either fires, that is the rule working, not a bug to route around.

## 12. Toolchain (once per machine)

Enforcement is agent-agnostic and lives in `lefthook.yml` (committed): format + lint on commit, typecheck + dependency check + tests on push, plus blocks on secrets, `.env` writes, and skipped tests. **Do not disable hooks, edit `lefthook.yml`, or use `--no-verify`.**

```bash
npm install          # installs lefthook and runs `lefthook install` via prepare
```

Shared skills live in `.agents/skills/` and arrive with `git clone`.

**Claude Code users** additionally get fast in-editor feedback from `.claude/settings.json` (already committed). Install the plugins once:

```bash
/plugin install frontend-design@claude-plugins-official
/plugin install code-review@claude-plugins-official
/plugin install security-guidance@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
npx skills add vercel-labs/agent-skills --skill web-design-guidelines --agent claude-code -g -y
```

**Codex / Cursor users** install the same skills for their agent:

```bash
npx skills add vercel-labs/agent-skills --skill web-design-guidelines --agent codex -g -y
npx skills add vercel-labs/agent-skills --skill react-performance --agent codex -g -y
```

For the UI audit in §6 without a skill installed, fetch the rules directly:
`https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`

### The same three obligations, per tool

These are rules, not preferences. Only the button changes.

| Obligation | Claude Code | Codex / Cursor |
|---|---|---|
| Plan before touching shared surfaces (§7, §8) | plan mode | `/plan`, or write the plan and stop for approval before editing |
| Self-review the diff before push (§9.5) | `/code-review` | `codex review`, or a fresh session: "review this diff against AGENTS.md §3, §5, §7" |
| UI audit on changed frontend (§6) | `/web-design-guidelines <files>` | same skill installed with `--agent codex`, or fetch the rules URL above |

If your tool has no equivalent, do it manually. Skipping is not an option.

Sources:
- https://github.com/vercel-labs/agent-skills — Vercel's official skills
- https://github.com/vercel-labs/skills — the `npx skills` CLI (supports Claude Code, Codex, Cursor)
- https://github.com/vercel-labs/web-interface-guidelines — the 100+ UI rules
- https://github.com/anthropics/skills — Anthropic's public skills
- https://lefthook.dev — git hooks manager

<!--
MAINTAINER NOTES (agents ignore HTML comments — free to write here)
- Keep this file under ~200 lines. If a section grows, move it to docs/agent/ and leave a pointer.
- Historical decisions (which sprint retired R2R, etc.) belong in git log, not here.
- Add a rule here only after an agent has made the same mistake twice.
- Anything a linter, hook, or CI check can enforce should NOT be a rule here — make it a check.
- CLAUDE.md imports this file. Never duplicate content into it.
-->
