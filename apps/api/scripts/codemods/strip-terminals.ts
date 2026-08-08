/**
 * Sprint 74 Stage B — remove the SQLite-only drizzle terminals.
 *
 * better-sqlite3's drizzle dialect exposes `.all()` / `.get()` / `.run()` on
 * every query builder. pg-core has none of them: awaiting the builder itself
 * runs the query.
 *
 *   x.all()  ->  x                     (already an array)
 *   x.run()  ->  x                     (QueryResult; `.changes` -> `.rowCount`)
 *   x.get()  ->  (await x)[0]          (first row or undefined)
 *
 * `.get()` is the only one that changes the value, so it is rewritten at the
 * enclosing `await` and re-parenthesised. `noUncheckedIndexedAccess` is on, so
 * `[0]` is typed `T | undefined` — exactly what `.get()` returned.
 *
 * Detection is by the *receiver's* type, not the call's: after the dialect swap
 * `.all` no longer resolves to anything, so there is no symbol to look at.
 *
 * Edits are applied as raw text so no AST invalidation can corrupt a nested
 * rewrite; when one match encloses another only the inner one is applied and
 * the file is re-parsed, so the pass runs to a fixpoint.
 *
 * Idempotent — safe to re-run until it reports 0.
 */
import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";

const TERMINALS = new Set(["all", "get", "run"]);
/** Query-builder classes whose awaited value is the result. */
const BUILDER = /\bPg(Select|Insert|Update|Delete|Refresh|Relational|With|Raw)|\bQueryPromise</;

interface Edit {
  start: number;
  end: number;
  text: string;
}

function receiverIsBuilder(node: Node): boolean {
  try {
    const type = node.getType();
    if (BUILDER.test(type.getText())) return true;
    const decls = type.getSymbol()?.getDeclarations() ?? [];
    return decls.some((d) => d.getSourceFile().getFilePath().includes("drizzle-orm"));
  } catch {
    return false;
  }
}

function matches(file: SourceFile): CallExpression[] {
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;
    if (!TERMINALS.has(expr.getName())) return false;
    if (call.getArguments().length > 0) return false;
    return receiverIsBuilder(expr.getExpression());
  });
}

function editFor(call: CallExpression): Edit {
  const expr = call.getExpression() as import("ts-morph").PropertyAccessExpression;
  const receiver = expr.getExpression();
  if (expr.getName() !== "get") {
    // Drop `.all()` / `.run()`: keep everything up to the end of the receiver.
    return { start: call.getStart(), end: call.getEnd(), text: receiver.getText() };
  }
  // Rewrite at the `await` so the index lands on the resolved array. An
  // unawaited `.get()` should not survive Stage A, but handle it exactly.
  const parent = call.getParent();
  const root = parent && Node.isAwaitExpression(parent) ? parent : call;
  return { start: root.getStart(), end: root.getEnd(), text: `(await ${receiver.getText()})[0]` };
}

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

let stripped = 0;
let gets = 0;
let deferred = 0;

for (const file of files) {
  for (let pass = 0; pass < 10; pass++) {
    const found = matches(file);
    if (found.length === 0) break;

    const edits = found.map((call) => ({ call, edit: editFor(call) }));
    // An enclosing match would swallow the inner rewrite; leave it for the
    // next pass, once the inner one is part of the file's text.
    const applicable = edits.filter(
      ({ edit }) =>
        !edits.some(
          (other) =>
            other.edit !== edit && other.edit.start <= edit.start && other.edit.end >= edit.end,
        ),
    );
    deferred += edits.length - applicable.length;

    let text = file.getFullText();
    for (const { call, edit } of applicable.sort((a, b) => b.edit.start - a.edit.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      stripped++;
      if ((call.getExpression() as import("ts-morph").PropertyAccessExpression).getName() === "get") {
        gets++;
      }
    }
    file.replaceWithText(text);
    if (applicable.length === edits.length) break;
  }
}

project.saveSync();
console.log(
  `stripped ${stripped} terminals (${gets} were .get() -> [0]); ${deferred} nested rewrites deferred to a later pass`,
);
