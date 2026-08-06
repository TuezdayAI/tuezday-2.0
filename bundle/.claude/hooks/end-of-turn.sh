#!/usr/bin/env bash
# .claude/hooks/end-of-turn.sh — Stop hook. Exit 2 makes Claude keep working until clean.
set -uo pipefail

INPUT=$(cat)

# Guard against infinite loops: only block once per turn.
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

# Nothing changed? Nothing to check.
git diff --quiet && git diff --cached --quiet && exit 0

FAILED=""

if ! npx --no-install biome check . >/tmp/tz-lint.log 2>&1; then
  FAILED="lint"
  tail -30 /tmp/tz-lint.log >&2
fi

if ! npm run typecheck >/tmp/tz-tsc.log 2>&1; then
  FAILED="$FAILED typecheck"
  tail -30 /tmp/tz-tsc.log >&2
fi

if [ -n "$FAILED" ]; then
  echo "" >&2
  echo "END-OF-TURN GATE FAILED:$FAILED — fix before finishing (CLAUDE.md §1)." >&2
  exit 2
fi

exit 0
