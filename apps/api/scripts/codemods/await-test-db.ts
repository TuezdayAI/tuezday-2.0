/**
 * Sprint 74 Stage B — `createTestDb()` became async.
 *
 * Awaits every call and marks the enclosing function async. Most call sites are
 * already inside an async `beforeEach`; the rest are sync hook callbacks that
 * only ever needed to be sync because better-sqlite3 was.
 *
 * Idempotent — safe to re-run until it reports 0.
 */
import { Node, Project, SyntaxKind, type FunctionLikeDeclaration } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

const isFnNode = (n: Node): n is FunctionLikeDeclaration =>
  Node.isFunctionDeclaration(n) ||
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n) ||
  Node.isMethodDeclaration(n);

let awaited = 0;
let asyncified = 0;

for (const file of files) {
  const calls = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === "createTestDb")
    .filter((c) => !Node.isAwaitExpression(c.getParent()));
  if (calls.length === 0) continue;

  // Mark enclosing functions async first: it is a structural edit, and doing it
  // before the text splice keeps the recorded positions valid.
  const owners = new Set<FunctionLikeDeclaration>();
  for (const call of calls) {
    const fn = call.getAncestors().find(isFnNode);
    if (fn && !fn.isAsync()) owners.add(fn);
  }
  for (const fn of owners) {
    fn.setIsAsync(true);
    asyncified++;
  }

  // Re-find after the async edits, then splice text right-to-left.
  const fresh = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === "createTestDb")
    .filter((c) => !Node.isAwaitExpression(c.getParent()))
    .sort((a, b) => b.getStart() - a.getStart());

  let text = file.getFullText();
  for (const call of fresh) {
    text = `${text.slice(0, call.getStart())}await ${text.slice(call.getStart())}`;
    awaited++;
  }
  file.replaceWithText(text);
}

project.saveSync();
console.log(`awaited ${awaited} createTestDb() calls; marked ${asyncified} functions async`);
