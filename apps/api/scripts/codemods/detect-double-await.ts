/**
 * Sprint 74 detector — promises a test deliberately holds.
 *
 * Several tests start work, do something else (advance timers, run a second
 * instance, abort a controller), and only then await. Stage A awaited at the
 * assignment, which serialises exactly the overlap the test exists to prove —
 * and because awaiting a settled value is legal, nothing type-checks as wrong;
 * it just hangs or passes vacuously.
 *
 * The signature is a variable initialised with `await` and awaited *again*
 * later, or handed to Promise.all/race/allSettled. Reports rather than
 * rewrites: whether the await belongs at the assignment or at the later use is
 * a judgement about what the test means.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

const COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
let found = 0;

function isLaterAwait(reference: Node): boolean {
  const parent = reference.getParent();
  if (parent && Node.isAwaitExpression(parent)) return true;
  // Promise.all([pending, other]) and friends.
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
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isAwaitExpression(initializer)) continue;
    const nameNode = declaration.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;

    const laterAwaits = nameNode
      .findReferencesAsNodes()
      .filter((reference) => reference !== nameNode)
      .filter(isLaterAwait);
    if (laterAwaits.length === 0) continue;

    found++;
    const { line } = file.getLineAndColumnAtPos(declaration.getStart());
    console.log(
      `${file.getFilePath().replace(process.cwd() + "/", "")}:${line}  ` +
        `${nameNode.getText()} — awaited at assignment and again at ` +
        laterAwaits
          .map((r) => file.getLineAndColumnAtPos(r.getStart()).line)
          .join(", "),
    );
  }
}

console.log(`\n${found} held-promise sites`);
