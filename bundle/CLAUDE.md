@AGENTS.md

## Claude Code only

Everything above is the shared rulebook — it applies identically to Codex and Cursor. Do not duplicate any of it here.

- Use plan mode for any change touching `packages/contracts`, `apps/api/src/db/schema.ts`, `apps/api/src/app.ts`, or `apps/api/src/auth/`.
- `.claude/settings.json` hooks give you format-on-write and an end-of-turn typecheck. They are a convenience layer on top of the git hooks, not a replacement. Do not edit or disable them.
- Run `/code-review` on the full diff before pushing a sprint branch (AGENTS.md §9.5).
- Run `/web-design-guidelines <changed files>` for the UI audit in AGENTS.md §6.
- Skills in `.claude/skills/` are symlinks to `.agents/skills/`. Edit the target, never the link.
