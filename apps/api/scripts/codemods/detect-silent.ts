/**
 * Sprint 74 — detect promises in positions TypeScript will not complain about.
 *
 * `expect(p)`, `if (p)`, `!p`, `p && x`, `${p}` and friends all accept a
 * Promise silently. After the async cascade these are the residual bugs the
 * typechecker cannot see.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

function isPromise(n: Node): boolean {
  try {
    const t = n.getType();
    return t.getSymbol()?.getName() === "Promise" || /^Promise\s*</.test(t.getText());
  } catch {
    return false;
  }
}

let found = 0;
const report: string[] = [];

for (const f of files) {
  const rel = f.getFilePath().split("/apps/api/")[1] ?? f.getBaseName();

  for (const node of f.getDescendants()) {
    if (!Node.isExpression(node) || !isPromise(node)) continue;
    if (Node.isAwaitExpression(node.getParent())) continue;

    const parent = node.getParent();
    let kind: string | undefined;

    // expect(<promise>)
    if (
      Node.isCallExpression(parent) &&
      parent.getExpression().getText() === "expect" &&
      parent.getArguments()[0] === node
    ) {
      kind = "expect(promise)";
    }
    // if (<promise>) / while (<promise>)
    else if (
      (Node.isIfStatement(parent) || Node.isWhileStatement(parent)) &&
      parent.getExpression() === node
    ) {
      kind = "truthiness";
    }
    // !<promise>
    else if (
      Node.isPrefixUnaryExpression(parent) &&
      parent.getOperatorToken() === SyntaxKind.ExclamationToken
    ) {
      kind = "negation";
    }
    // <promise> && / || / ??
    else if (
      Node.isBinaryExpression(parent) &&
      ["&&", "||", "??"].includes(parent.getOperatorToken().getText()) &&
      parent.getLeft() === node
    ) {
      kind = "logical-operand";
    }
    // `${<promise>}`
    else if (Node.isTemplateSpan(parent)) {
      kind = "template-literal";
    }
    // <promise> ? a : b
    else if (Node.isConditionalExpression(parent) && parent.getCondition() === node) {
      kind = "ternary-condition";
    }

    if (!kind) continue;
    found++;
    report.push(`  ${kind.padEnd(18)} ${rel}:${node.getStartLineNumber()}  ${node.getText().replace(/\s+/g, " ").slice(0, 72)}`);
  }
}

console.log(report.join("\n"));
console.log(`\n${found} silent promise use(s)`);
