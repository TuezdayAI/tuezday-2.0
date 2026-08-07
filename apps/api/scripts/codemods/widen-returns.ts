/**
 * Sprint 74 — widen return annotations on pass-through functions.
 *
 * A non-async function that `return`s a promise (typically `return
 * db.transaction(...)`) keeps its old `: T` annotation. The value is already
 * correct at runtime; only the declaration lies. Widen `: T` to `: Promise<T>`.
 */
import { Node, Project, SyntaxKind, type FunctionLikeDeclaration } from "ts-morph";

type Fn = FunctionLikeDeclaration;
const isFnNode = (n: Node): n is Fn =>
  Node.isFunctionDeclaration(n) ||
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n) ||
  Node.isMethodDeclaration(n);

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

let widened = 0;
for (const f of files) {
  for (const fn of f.getDescendants().filter(isFnNode)) {
    if (fn.isAsync?.()) continue;
    const rtNode = fn.getReturnTypeNode();
    if (!rtNode) continue;
    const rt = rtNode.getText();
    if (/^Promise\s*</.test(rt)) continue;

    const returnsPromise = fn
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => r.getFirstAncestor(isFnNode) === fn)
      .some((r) => {
        const e = r.getExpression();
        if (!e) return false;
        try {
          const t = e.getType();
          return t.getSymbol()?.getName() === "Promise" || /^Promise\s*</.test(t.getText());
        } catch {
          return false;
        }
      });
    if (!returnsPromise) continue;

    fn.setReturnType(`Promise<${rt}>`);
    widened++;
    console.log(`  ${f.getFilePath().split("/apps/api/")[1]}:${fn.getStartLineNumber()}  ${rt.slice(0, 60)}`);
  }
}
console.log(`\nwidened ${widened} return annotations`);
project.saveSync();
