/**
 * Sprint 74 detector — `expect(() => f()).toThrow()` where f is now async.
 *
 * An async function does not throw; it returns a rejected promise. The
 * assertion passes vacuously in neither direction — it fails, claiming nothing
 * was thrown — so these are loud rather than silent, but they need the
 * `.rejects` form, which is a judgement call per site.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));
let found = 0;

for (const file of files) {
  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (!/^toThrow/.test(access.getName())) continue;
    const receiver = access.getExpression();
    if (!Node.isCallExpression(receiver) || receiver.getExpression().getText() !== "expect") continue;
    const [arg] = receiver.getArguments();
    if (!arg || (!Node.isArrowFunction(arg) && !Node.isFunctionExpression(arg))) continue;

    const returnsPromise = arg.isAsync() || /^Promise\s*</.test(arg.getReturnType().getText());
    if (!returnsPromise) continue;
    found++;
    const { line } = file.getLineAndColumnAtPos(access.getStart());
    console.log(`${file.getFilePath().replace(process.cwd() + "/", "")}:${line}`);
  }
}
console.log(`\n${found} sync-throw assertions on async callbacks`);
