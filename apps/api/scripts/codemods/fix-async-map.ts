/**
 * Sprint 74 — repair `.map(async …)`.
 *
 * Promoting callbacks to async turned `xs.map(fn)` into `Promise<T>[]`. Wrap
 * each in `Promise.all(...)` so the value is an array again. Sites already
 * inside a Promise.all are left alone.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

let fixed = 0;
for (const f of files) {
  for (;;) {
    const target = f.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "map") return false;
      const cb = call.getArguments()[0];
      if (!cb || !(Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) return false;
      if (!cb.isAsync()) return false;
      // Already wrapped?
      const p = call.getParent();
      if (
        Node.isCallExpression(p) &&
        Node.isPropertyAccessExpression(p.getExpression()) &&
        p.getExpression().getText() === "Promise.all"
      ) {
        return false;
      }
      return true;
    });
    if (!target) break;
    const text = target.getText();
    target.replaceWithText(`Promise.all(${text})`);
    fixed++;
    console.log(`  ${f.getFilePath().split("/apps/api/")[1]}: wrapped .map(async …)`);
  }
}
console.log(`\nwrapped ${fixed} map callbacks in Promise.all`);
project.saveSync();
