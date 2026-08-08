/**
 * Sprint 74 detector — `await` on an array of promises.
 *
 * `.map(async …)` and `Array.from(…, async …)` produce `Promise<T>[]`. Awaiting
 * that array resolves to the array itself, unchanged — the work is still
 * pending and the value is a list of Promise objects. It needs Promise.all.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));
let found = 0;

for (const file of files) {
  for (const expression of file.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const type = expression.getExpression().getType();
    if (!type.isArray()) continue;
    const element = type.getArrayElementType()?.getText() ?? "";
    if (!/^Promise\s*</.test(element)) continue;
    found++;
    const { line } = file.getLineAndColumnAtPos(expression.getStart());
    console.log(`${file.getFilePath().replace(process.cwd() + "/", "")}:${line}  ${element.slice(0, 60)}`);
  }
}
console.log(`\n${found} awaited promise arrays`);
