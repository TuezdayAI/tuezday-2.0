/**
 * Sprint 74 repair — `expect(await p).rejects` is not an assertion.
 *
 * Stage A awaited every call whose type became a promise. Inside
 * `expect(...).rejects` / `.resolves` that is exactly wrong: the point is to
 * hand the *unsettled* promise to expect. Awaiting it first makes the
 * rejection escape as a thrown error and the test fail with the very message
 * it was asserting on.
 *
 * Only `.rejects`/`.resolves` chains are touched, and only when expect's sole
 * argument is an await — a plain `expect(await p).toBe(x)` is correct and is
 * left alone.
 *
 * Idempotent — safe to re-run until it reports 0.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

let fixed = 0;

for (const file of files) {
  const edits: { start: number; end: number }[] = [];

  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const name = access.getName();
    if (name !== "rejects" && name !== "resolves") continue;

    const receiver = access.getExpression();
    if (!Node.isCallExpression(receiver)) continue;
    if (receiver.getExpression().getText() !== "expect") continue;

    const [arg] = receiver.getArguments();
    if (!arg || !Node.isAwaitExpression(arg)) continue;

    // Drop just the `await ` keyword and the whitespace after it.
    edits.push({ start: arg.getStart(), end: arg.getExpression().getStart() });
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
console.log(`removed ${fixed} awaits from expect(...).rejects/.resolves`);
