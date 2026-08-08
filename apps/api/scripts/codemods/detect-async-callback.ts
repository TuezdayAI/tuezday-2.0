/**
 * Sprint 74 detector — array methods handed an async callback.
 *
 * These do not await anything. `filter`/`some`/`every`/`find` see a Promise,
 * which is always truthy, so the predicate is effectively `() => true`;
 * `forEach` is fire-and-forget; `map`/`flatMap` yield promises. The type
 * checker is happy with all of them.
 *
 * `map`/`flatMap` are excluded when the result is passed to Promise.all — that
 * is the correct idiom, not a bug.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

const METHODS = new Set([
  "filter", "some", "every", "find", "findIndex", "findLast",
  "forEach", "map", "flatMap", "sort", "reduce",
]);
let found = 0;

function insidePromiseCombinator(node: Node): boolean {
  return node.getAncestors().some((ancestor) => {
    if (!Node.isCallExpression(ancestor)) return false;
    const callee = ancestor.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === "Promise" &&
      ["all", "allSettled", "race", "any"].includes(callee.getName())
    );
  });
}

for (const file of files) {
  if (file.getFilePath().includes("/scripts/codemods/")) continue;
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (!METHODS.has(method)) continue;
    const [callback] = call.getArguments();
    if (!callback || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))) {
      continue;
    }
    if (!callback.isAsync()) continue;
    if ((method === "map" || method === "flatMap") && insidePromiseCombinator(call)) continue;

    found++;
    const { line } = file.getLineAndColumnAtPos(call.getStart());
    console.log(`${file.getFilePath().replace(process.cwd() + "/", "")}:${line}  .${method}(async …)`);
  }
}
console.log(`\n${found} array methods with an async callback`);
