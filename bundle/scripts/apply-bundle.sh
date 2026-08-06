#!/usr/bin/env bash
# Run from the root of the tuezday repo:
#   bash /path/to/bundle/scripts/apply-bundle.sh /path/to/bundle
# Creates the branch, drops files in place, wires package.json, commits.
set -euo pipefail

BUNDLE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="chore/agent-guardrails"

[ -d .git ] || { echo "Run this from the repo root."; exit 1; }
git diff --quiet || { echo "Working tree is dirty. Commit or stash first."; exit 1; }

git checkout main && git pull --ff-only
git checkout -b "$BRANCH"

# 1. Files
mkdir -p .claude/hooks .agents/skills .github/workflows docs/agent scripts
cp "$BUNDLE/AGENTS.md" "$BUNDLE/CLAUDE.md" "$BUNDLE/lefthook.yml" \
   "$BUNDLE/biome.json" "$BUNDLE/.dependency-cruiser.cjs" .
cp "$BUNDLE/.claude/settings.json" .claude/settings.json
cp "$BUNDLE/.claude/hooks/"*.sh .claude/hooks/
cp -r "$BUNDLE/.agents/skills/tuezday-design" .agents/skills/
cp "$BUNDLE/.github/CODEOWNERS" .github/CODEOWNERS
cp "$BUNDLE/.github/workflows/ci.yml" .github/workflows/ci.yml
cp "$BUNDLE/docs/agent/"* docs/agent/
cp "$BUNDLE/scripts/generate-dependency-map.mjs" scripts/
chmod +x .claude/hooks/*.sh

# 2. Claude reads skills from .claude/skills; keep one source of truth.
rm -rf .claude/skills
ln -s ../.agents/skills .claude/skills

# 3. Generated map is not committed.
grep -qxF 'docs/agent/dependency-map.md' .gitignore 2>/dev/null || \
  echo 'docs/agent/dependency-map.md' >> .gitignore

# 4. package.json: scripts + devDeps + hook install
node - << 'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.scripts = {
  ...p.scripts,
  lint: 'biome check .',
  'lint:fix': 'biome check --write .',
  graph: 'node scripts/generate-dependency-map.mjs',
  'graph:check': 'depcruise apps packages --validate',
  prepare: p.scripts?.prepare ? `${p.scripts.prepare} && lefthook install` : 'lefthook install',
};
p.devDependencies = {
  ...p.devDependencies,
  '@biomejs/biome': '^2.0.0',
  'dependency-cruiser': '^16.0.0',
  lefthook: '^1.7.0',
};
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('package.json updated');
NODE

npm install

# 5. Absorb formatting churn in its own commit so the rules commit stays readable.
npm run lint:fix || true
git add -A package.json package-lock.json
git add -A -- ':!AGENTS.md' ':!CLAUDE.md' ':!lefthook.yml' ':!.claude' ':!.agents' ':!.github' ':!docs/agent'
git commit -q -m "chore: add biome, dependency-cruiser, lefthook; format repo" || true

git add -A
git commit -q -m "chore: agent guardrails — AGENTS.md rulebook, git hooks, boundary checks

Co-Authored-By: Claude"

echo
echo "Branch $BRANCH created and committed. Next:"
echo "  1. Edit .github/CODEOWNERS — replace @FOUNDER"
echo "  2. git push -u origin $BRANCH"
echo "  3. Merge, then apply docs/agent/github-protection.md"
