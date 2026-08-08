/**
 * Sprint 74 repair — drop the assignment-time await on a held promise.
 *
 * Companion to detect-double-await.ts: where a variable is initialised with
 * `await` and awaited again later, the later await is the one that settles it,
 * so the first is both redundant and destructive — it serialises work the
 * caller meant to overlap, and it moves a rejection out of the try/catch that
 * was written around the second await.
 *
 * Idempotent — safe to re-run until it reports 0.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

const COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
let fixed = 0;

function isLaterAwait(reference: Node): boolean {
  const parent = reference.getParent();
  if (parent && Node.isAwaitExpression(parent)) return true;
  const array = parent && Node.isArrayLiteralExpression(parent) ? parent.getParent() : parent;
  if (array && Node.isCallExpression(array)) {
    const callee = array.getExpression();
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === "Promise" &&
      COMBINATORS.has(callee.getName())
    ) {
      return true;
    }
  }
  return false;
}

for (const file of files) {
  const edits: { start: number; end: number }[] = [];

  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isAwaitExpression(initializer)) continue;
    const nameNode = declaration.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;
    const later = nameNode
      .findReferencesAsNodes()
      .filter((reference) => reference !== nameNode)
      .some(isLaterAwait);
    if (!later) continue;
    edits.push({ start: initializer.getStart(), end: initializer.getExpression().getStart() });
    fixed++;
  }

  if (edits.length === 0) continue;
  let text = file.getFullText();
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + text.slice(edit.end);
  }
  file.replaceWithText(text);
}

project.saveSync();
console.log(`removed ${fixed} assignment-time awaits on held promises`);
