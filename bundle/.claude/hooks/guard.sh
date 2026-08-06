#!/usr/bin/env bash
# .claude/hooks/guard.sh — PreToolUse. Exit 2 blocks the edit; reason goes to stderr.
set -uo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
BODY=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

[ -z "$FILE" ] && exit 0

# 1. Secrets / env files are never written by an agent.
case "$FILE" in
  *.env|*.env.*|*/.env|*id_rsa*|*.pem)
    echo "BLOCKED: agents do not write env or key files (CLAUDE.md §11). Ask the human." >&2
    exit 2
    ;;
esac

# 2. No unrequested markdown. Specs are the one exception.
case "$FILE" in
  *.md)
    case "$FILE" in
      */docs/specs/*|*/CLAUDE.md) ;;
      *)
        echo "BLOCKED: no unrequested .md files (CLAUDE.md §4). Only docs/specs/ is allowed." >&2
        exit 2
        ;;
    esac
    ;;
esac

# 3. No test gaming.
if echo "$BODY" | grep -qE '\b(it|test|describe)\.(skip|only|todo)\b'; then
  echo "BLOCKED: skipped/exclusive tests are not allowed (CLAUDE.md §5). Fix the code or ask." >&2
  exit 2
fi

# 4. Obvious secret literals.
if echo "$BODY" | grep -qE '(sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)'; then
  echo "BLOCKED: possible hardcoded secret in this edit." >&2
  exit 2
fi

# 5. Warn (do not block) on shared-surface edits so the blast radius gets stated.
case "$FILE" in
  */packages/contracts/*|*/apps/api/src/db/schema.ts|*/apps/api/src/app.ts)
    echo "NOTE: shared surface. State the blast radius and run 'npm run graph' first (CLAUDE.md §7)." >&2
    ;;
esac

exit 0
