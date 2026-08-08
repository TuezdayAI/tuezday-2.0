/**
 * Sprint 74 detector — `.rejects` on a value that was already awaited.
 *
 * The companion to fix-rejects-await.ts, for the indirect shape: a helper
 * awaits the work and hands the *result* back, and the caller then asserts
 * `.rejects` on it. Vitest reports "You must provide a Promise to expect()",
 * or, if the awaited call threw, the test dies at the helper instead.
 *
 * Reports the identifier and where it came from; the fix is always to stop
 * awaiting at the producer, but which producer is a judgement.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));
let found = 0;

for (const file of files) {
  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const name = access.getName();
    if (name !== "rejects" && name !== "resolves") continue;
    const call = access.getExpression();
    if (!Node.isCallExpression(call) || call.getExpression().getText() !== "expect") continue;
    const [arg] = call.getArguments();
    if (!arg || !Node.isIdentifier(arg)) continue;

    // A promise-typed identifier is fine; a settled one is the bug.
    const type = arg.getType().getText();
    if (/^Promise\s*</.test(type) || type.includes("PromiseLike")) continue;

    found++;
    const { line } = file.getLineAndColumnAtPos(access.getStart());
    console.log(
      `${file.getFilePath().replace(process.cwd() + "/", "")}:${line}  ` +
        `expect(${arg.getText()}).${name} — ${arg.getText()} is ${type.slice(0, 60)}`,
    );
  }
}
console.log(`\n${found} settled values asserted with .rejects/.resolves`);
