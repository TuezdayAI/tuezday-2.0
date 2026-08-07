/**
 * Sprint 74 Stage A — ANALYSIS ONLY. Mutates nothing.
 *
 * Answers three questions before the codemod runs:
 *  1. Can we reliably identify drizzle query terminals via declaration origin?
 *  2. How many functions are transaction-tainted (must stay sync in Stage A,
 *     because better-sqlite3 rejects async transaction callbacks)?
 *  3. How many terminals are therefore in scope for Stage A?
 */
import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });

const files = project
  .getSourceFiles()
  .filter((f) => !f.getFilePath().includes("node_modules"));

/** True when the called symbol is declared inside drizzle-orm itself. */
function isDrizzleCall(call: CallExpression): boolean {
  const decls = call.getExpression().getSymbol()?.getDeclarations() ?? [];
  return decls.some((d) => d.getSourceFile().getFilePath().includes("drizzle-orm"));
}

const TERMINALS = new Set(["all", "get", "run", "execute"]);

function terminalName(call: CallExpression): string | undefined {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return undefined;
  const name = expr.getName();
  return TERMINALS.has(name) ? name : undefined;
}

/** The function-ish node that encloses a node, if any. */
function enclosingFunction(node: Node): Node | undefined {
  return node.getAncestors().find(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
}

// ---------------------------------------------------------------- taint ----
// Seed: every callback passed to a `.transaction(...)` call.
const txCallbacks: Node[] = [];
for (const f of files) {
  for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    if (expr.getName() !== "transaction") continue;
    const cb = call.getArguments()[0];
    if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) txCallbacks.push(cb);
  }
}

/** Transitively: every user-defined function reachable from a tx callback. */
const tainted = new Set<Node>();
const queue: Node[] = [...txCallbacks];
for (const cb of txCallbacks) tainted.add(cb);

while (queue.length) {
  const fn = queue.pop()!;
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const decls = call.getExpression().getSymbol()?.getDeclarations() ?? [];
    for (const d of decls) {
      const path = d.getSourceFile().getFilePath();
      if (path.includes("node_modules")) continue;
      if (!path.includes("/apps/api/src/")) continue;
      const target =
        Node.isFunctionDeclaration(d) ||
        Node.isArrowFunction(d) ||
        Node.isFunctionExpression(d) ||
        Node.isMethodDeclaration(d)
          ? d
          : Node.isVariableDeclaration(d)
            ? d.getInitializerIfKind(SyntaxKind.ArrowFunction) ??
              d.getInitializerIfKind(SyntaxKind.FunctionExpression)
            : undefined;
      if (target && !tainted.has(target)) {
        tainted.add(target);
        queue.push(target);
      }
    }
  }
}

// -------------------------------------------------------------- measure ----
let drizzleTerminals = 0;
let alreadyAwaited = 0;
let inTainted = 0;
let inScope = 0;
const byName = new Map<string, number>();
const scopeByFile = new Map<string, number>();
const unmatched: string[] = [];

for (const f of files) {
  for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = terminalName(call);
    if (!name) continue;
    if (!isDrizzleCall(call)) {
      if (unmatched.length < 12) {
        unmatched.push(
          `${f.getBaseName()}:${call.getStartLineNumber()} ${call.getText().slice(0, 70).replace(/\s+/g, " ")}`,
        );
      }
      continue;
    }
    drizzleTerminals++;
    byName.set(name, (byName.get(name) ?? 0) + 1);

    if (Node.isAwaitExpression(call.getParent())) {
      alreadyAwaited++;
      continue;
    }
    const fn = enclosingFunction(call);
    const isTainted = !!fn && [...tainted].some((t) => t === fn || fn.getAncestors().includes(t));
    if (isTainted) {
      inTainted++;
    } else {
      inScope++;
      const p = f.getFilePath().split("/apps/api/")[1] ?? f.getBaseName();
      scopeByFile.set(p, (scopeByFile.get(p) ?? 0) + 1);
    }
  }
}

console.log("=== files in project:", files.length);
console.log("=== drizzle terminal calls:", drizzleTerminals, Object.fromEntries(byName));
console.log("=== already awaited:", alreadyAwaited);
console.log("=== transaction callbacks (seed):", txCallbacks.length);
console.log("=== transitively tainted functions:", tainted.size);
console.log("=== terminals inside tainted code (deferred to Stage B):", inTainted);
console.log("=== terminals IN SCOPE for Stage A:", inScope);
console.log("\n--- non-drizzle .all()/.get()/.run()/.execute() (must NOT be touched) ---");
for (const u of unmatched) console.log("   ", u);
console.log("\n--- top 15 files by in-scope terminals ---");
for (const [p, n] of [...scopeByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`   ${String(n).padStart(4)}  ${p}`);
}
