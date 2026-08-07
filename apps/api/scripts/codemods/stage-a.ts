/**
 * Sprint 74 Stage A — async cascade, still on SQLite.
 *
 * PROMOTE: compute (by call graph, to a fixpoint) every function that
 *          transitively performs a drizzle query, mark it `async`, and widen
 *          its return annotation to Promise<T>.
 * WRAP:    reload, then await every drizzle terminal and every call that now
 *          has a Promise type, parenthesising where the parent binds tighter
 *          than `await` (member access, call callee, non-null).
 *
 * Transaction-tainted code is excluded throughout: better-sqlite3 rejects an
 * async transaction callback, so those functions flip in Stage B instead.
 *
 * Idempotent — safe to re-run until it reports 0/0.
 */
import { Node, Project, SyntaxKind, type CallExpression, type FunctionLikeDeclaration } from "ts-morph";

type Fn = FunctionLikeDeclaration;
// `transaction` counts: it returns the callback's result and, once the callback
// is async, that result is a promise the caller must await.
const TERMINALS = new Set(["all", "get", "run", "execute", "transaction"]);

const isFnNode = (n: Node): n is Fn =>
  Node.isFunctionDeclaration(n) ||
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n) ||
  Node.isMethodDeclaration(n);

const enclosingFn = (n: Node): Fn | undefined => n.getAncestors().find(isFnNode) as Fn | undefined;

function isDrizzleTerminal(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr) || !TERMINALS.has(expr.getName())) return false;
  const decls = call.getExpression().getSymbol()?.getDeclarations() ?? [];
  return decls.some((d) => d.getSourceFile().getFilePath().includes("drizzle-orm"));
}

function resolveUserFn(call: CallExpression): Fn | undefined {
  // For an imported identifier the call's symbol is the *alias* (the import
  // specifier), whose declarations are not function nodes — resolve through it
  // or cross-module propagation stops dead at every import boundary.
  let sym = call.getExpression().getSymbol();
  if (sym) {
    try {
      const aliased = sym.getAliasedSymbol();
      if (aliased) sym = aliased;
    } catch {
      /* not an alias */
    }
  }
  for (const d of sym?.getDeclarations() ?? []) {
    const p = d.getSourceFile().getFilePath();
    if (p.includes("node_modules") || !p.includes("/apps/api/")) continue;
    if (isFnNode(d)) return d;
    if (Node.isVariableDeclaration(d)) {
      const init =
        d.getInitializerIfKind(SyntaxKind.ArrowFunction) ??
        d.getInitializerIfKind(SyntaxKind.FunctionExpression);
      if (init) return init as Fn;
    }
  }
  return undefined;
}

function load() {
  const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
  const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));
  const seeds: Fn[] = [];
  for (const f of files) {
    for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const e = call.getExpression();
      if (!Node.isPropertyAccessExpression(e) || e.getName() !== "transaction") continue;
      const cb = call.getArguments()[0];
      if (cb && isFnNode(cb)) seeds.push(cb as Fn);
    }
  }
  const tainted = new Set<Node>(seeds);
  const queue: Fn[] = [...seeds];
  while (queue.length) {
    const fn = queue.pop()!;
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const t = resolveUserFn(call);
      if (t && !tainted.has(t)) {
        tainted.add(t);
        queue.push(t);
      }
    }
  }
  // Stage B: transactions flip too, so nothing is off-limits any more.
  const ignoreTaint = process.argv.includes("--no-taint");
  const isTainted = (n: Node) =>
    ignoreTaint ? false : tainted.has(n) || n.getAncestors().some((a) => tainted.has(a));
  return { project, files, isTainted };
}

// ---------------------------------------------------------------- PROMOTE --
let promoted = 0;
{
  const { project, files, isTainted } = load();
  const needsAsync = new Set<Fn>();

  for (const f of files) {
    for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isDrizzleTerminal(call) || isTainted(call)) continue;
      const fn = enclosingFn(call);
      if (fn && !isTainted(fn)) needsAsync.add(fn);
    }
  }

  for (let round = 1; ; round++) {
    let added = 0;
    for (const f of files) {
      for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isTainted(call)) continue;
        const target = resolveUserFn(call);
        if (!target || (!needsAsync.has(target) && target.isAsync?.() !== true)) continue;
        const caller = enclosingFn(call);
        if (!caller || needsAsync.has(caller) || caller.isAsync?.() === true) continue;
        if (isTainted(caller)) continue;
        needsAsync.add(caller);
        added++;
      }
    }
    console.log(`  promote fixpoint round ${round}: +${added} (total ${needsAsync.size})`);
    if (!added) break;
  }

  for (const fn of needsAsync) {
    if (fn.isAsync?.()) continue;
    if (Node.isGetAccessorDeclaration(fn.getParent()) || Node.isSetAccessorDeclaration(fn.getParent())) continue;
    const rtText = fn.getReturnTypeNode()?.getText();
    fn.setIsAsync(true);
    promoted++;
    if (rtText && !/^Promise\s*</.test(rtText)) fn.setReturnType(`Promise<${rtText}>`);
  }
  console.log(`PROMOTE: ${promoted} functions marked async`);
  project.saveSync();
}

// ------------------------------------------------------------------- WRAP --
let wrapped = 0;
{
  const { project, files, isTainted } = load();

  /** `await` binds looser than these, so the call needs parentheses. */
  function needsParens(call: CallExpression): boolean {
    const p = call.getParent();
    if (Node.isPropertyAccessExpression(p) || Node.isElementAccessExpression(p)) return true;
    if (Node.isNonNullExpression(p)) return true;
    if (Node.isTaggedTemplateExpression(p)) return true;
    if (Node.isCallExpression(p) && p.getExpression() === call) return true;
    return false;
  }

  function isPromiseTyped(call: CallExpression): boolean {
    try {
      const t = call.getType();
      return t.getSymbol()?.getName() === "Promise" || /^Promise\s*</.test(t.getText());
    } catch {
      return false;
    }
  }

  for (const f of files) {
    const edits: { pos: number; text: string }[] = [];

    for (const call of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (isTainted(call)) continue;

      const terminal = isDrizzleTerminal(call);
      if (!terminal && !isPromiseTyped(call)) continue;

      const parent = call.getParent();
      if (Node.isAwaitExpression(parent) || Node.isVoidExpression(parent)) continue;

      // `await` is illegal in a parameter default initializer — those three
      // sites were restructured by hand to resolve the default in the body.
      if (call.getAncestors().some((a) => Node.isParameterDeclaration(a))) continue;
      if (Node.isPropertyAccessExpression(parent)) {
        const n = parent.getName();
        if (n === "then" || n === "catch" || n === "finally") continue;
        // Still chaining the drizzle builder (`.from`, `.where`, …) — the
        // terminal further out is the real await point.
        if (!terminal && !isPromiseTyped(call)) continue;
      }
      if (
        call.getAncestors().some((a) => {
          if (!Node.isCallExpression(a)) return false;
          const e = a.getExpression();
          return (
            Node.isPropertyAccessExpression(e) &&
            e.getExpression().getText() === "Promise" &&
            ["all", "allSettled", "race", "any"].includes(e.getName())
          );
        })
      ) {
        continue;
      }

      const fn = enclosingFn(call);
      if (!fn || fn.isAsync?.() !== true) continue;

      // Pass-through `return p` from a function already typed Promise.
      if (Node.isReturnStatement(parent) && !fn.isAsync?.()) {
        const rt = fn.getReturnTypeNode()?.getText() ?? "";
        if (/^Promise\s*</.test(rt)) continue;
      }

      if (needsParens(call)) {
        edits.push({ pos: call.getStart(), text: "(await " });
        edits.push({ pos: call.getEnd(), text: ")" });
      } else {
        edits.push({ pos: call.getStart(), text: "await " });
      }
      wrapped++;
    }

    if (!edits.length) continue;
    // Pure insertions applied right-to-left: nesting stays correct.
    let text = f.getFullText();
    for (const e of edits.sort((a, b) => b.pos - a.pos)) {
      text = text.slice(0, e.pos) + e.text + text.slice(e.pos);
    }
    f.replaceWithText(text);
  }
  console.log(`WRAP: ${wrapped} calls awaited`);
  project.saveSync();
}

console.log(`\n=> promoted ${promoted}, wrapped ${wrapped}`);
