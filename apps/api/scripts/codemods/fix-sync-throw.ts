/**
 * Sprint 74 repair — `expect(async () => …).toThrow()` never throws.
 *
 * These assertions were written against synchronous better-sqlite3 calls. Now
 * that the call is async the callback returns a rejected promise instead of
 * throwing, and `.toThrow()` reports "did not throw" — the test fails while
 * describing the opposite of what happened.
 *
 * Rewritten to the promise form: invoke the callback and assert on `.rejects`.
 * The enclosing test body must already be async; any that is not is reported
 * rather than rewritten.
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

let fixed = 0;
const skipped: string[] = [];

for (const file of files) {
  const edits: { start: number; end: number; text: string }[] = [];

  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (!/^toThrow/.test(access.getName())) continue;
    const expectCall = access.getExpression();
    if (!Node.isCallExpression(expectCall) || expectCall.getExpression().getText() !== "expect") {
      continue;
    }
    const [callback] = expectCall.getArguments();
    if (!callback || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))) {
      continue;
    }
    if (!callback.isAsync() && !/^Promise\s*</.test(callback.getReturnType().getText())) continue;

    const enclosing = access.getAncestors().find(isFnNode);
    const { line } = file.getLineAndColumnAtPos(access.getStart());
    const where = `${file.getFilePath().replace(process.cwd() + "/", "")}:${line}`;
    if (!enclosing?.isAsync()) {
      skipped.push(`${where} (enclosing test is not async)`);
      continue;
    }

    // `expect(fn)` -> `await expect((fn)())`, and `.toThrow` -> `.rejects.toThrow`.
    edits.push({ start: expectCall.getStart(), end: expectCall.getStart(), text: "await " });
    edits.push({ start: callback.getStart(), end: callback.getStart(), text: "(" });
    edits.push({ start: callback.getEnd(), end: callback.getEnd(), text: ")()" });
    edits.push({ start: access.getNameNode().getStart(), end: access.getNameNode().getStart(), text: "rejects." });
    fixed++;
  }

  if (edits.length === 0) continue;
  let text = file.getFullText();
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  file.replaceWithText(text);
}

project.saveSync();
console.log(`rewrote ${fixed} assertions to the .rejects form`);
for (const note of skipped) console.log(`  SKIPPED ${note}`);
