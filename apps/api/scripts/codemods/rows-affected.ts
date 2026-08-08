/**
 * Sprint 74 Stage B — `.changes` -> `rowsAffected(...)`.
 *
 * better-sqlite3 reported rows written as `result.changes: number`.
 * node-postgres reports `result.rowCount: number | null` — null for statements
 * that carry no row count, which no DML does. Rather than sprinkle `?? 0` down
 * 40 call sites (and let the two arithmetic ones quietly become `number | null`
 * arithmetic), every read goes through one helper that documents the
 * nullability once.
 *
 * Idempotent — safe to re-run until it reports 0.
 */
import { Node, Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "apps/api/tsconfig.json" });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules"));

let rewritten = 0;
const touched: string[] = [];

for (const file of files) {
  if (file.getFilePath().includes("/scripts/codemods/")) continue;

  const hits = file
    .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .filter((access) => access.getName() === "changes")
    .filter((access) => {
      const type = access.getExpression().getType().getText();
      return type.includes("QueryResult");
    });
  if (hits.length === 0) continue;

  let text = file.getFullText();
  for (const access of hits.sort((a, b) => b.getStart() - a.getStart())) {
    const receiver = access.getExpression().getText();
    text =
      text.slice(0, access.getStart()) + `rowsAffected(${receiver})` + text.slice(access.getEnd());
    rewritten++;
  }
  file.replaceWithText(text);

  const dbModule = file.getRelativePathAsModuleSpecifierTo(
    project.getSourceFileOrThrow((f) => f.getFilePath().endsWith("/src/db/index.ts")),
  );
  const existing = file.getImportDeclaration((d) => d.getModuleSpecifierValue() === dbModule);
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === "rowsAffected")) {
      existing.addNamedImport("rowsAffected");
    }
  } else {
    file.addImportDeclaration({ moduleSpecifier: dbModule, namedImports: ["rowsAffected"] });
  }
  touched.push(file.getBaseName());
}

project.saveSync();
console.log(`rewrote ${rewritten} .changes reads across ${touched.length} files`);
