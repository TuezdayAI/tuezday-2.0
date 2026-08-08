/**
 * One-shot SQLite → Postgres data copy (Sprint 74).
 *
 *   npm run db:migrate-to-postgres -- [<sqlite-file>] [<database-url>]
 *
 * Defaults: `apps/api/tuezday.db` and DATABASE_URL. There is no production
 * database to carry across (founder decision D-74.4) — this exists so a
 * developer keeps the workspace they have been testing against, and so the
 * conversion rules are written down somewhere executable rather than only in
 * the spec.
 *
 * What it does NOT do, deliberately:
 *   * no incremental or resumable copy — it is one pass over a stopped database
 *   * no schema creation — the target must already be migrated (`createDb`
 *     does that), so the column set is the checked-in baseline, not whatever
 *     the source happens to have
 *   * no `evidence_chunks.embedding` conversion beyond the vector reformat
 *     below; a corpus that was never embedded stays unembedded and
 *     `npm run evidence:migrate`'s reindex pass fills it in
 *
 * Copy order is foreign-key order, which is derived from the schema rather
 * than hand-listed: a hand-listed order silently rots the first time a table
 * is added.
 */
import Database from "better-sqlite3";
import { getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { closeDb, createDb } from "../src/db";
import * as schema from "../src/db/schema";
import { resolveDatabaseUrl } from "../src/runtime/database-url";

const BATCH = 500;

interface TableInfo {
  name: string;
  /** Tables that must be copied first. */
  dependsOn: string[];
  columns: { sqlite: string; pg: string; kind: "boolean" | "vector" | "plain" }[];
}

function describeTables(): TableInfo[] {
  const tables: TableInfo[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    tables.push({
      name: getTableName(value),
      dependsOn: config.foreignKeys
        .map((fk) => getTableName(fk.reference().foreignTable))
        .filter((name) => name !== getTableName(value)),
      columns: config.columns
        // Serial columns are assigned by the target's sequence — carrying the
        // source value would leave the sequence behind the highest row. Keyed
        // on the column *type*, not the name: `evidence_chunks.seq` is an
        // ordinary integer holding a chunk's position in its document.
        .filter((column) => !/Serial/.test(column.columnType))
        .map((column) => ({
          sqlite: column.name,
          pg: column.name,
          kind:
            column.columnType === "PgBoolean"
              ? "boolean"
              : column.columnType === "PgVector"
                ? "vector"
                : "plain",
        })),
    });
  }
  return tables;
}

/** Topological order; a cycle falls back to declaration order for the rest. */
function copyOrder(tables: TableInfo[]): TableInfo[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set<string>();
  const ordered: TableInfo[] = [];

  let progress = true;
  while (progress) {
    progress = false;
    for (const table of tables) {
      if (done.has(table.name)) continue;
      if (table.dependsOn.every((name) => done.has(name) || !byName.has(name))) {
        done.add(table.name);
        ordered.push(table);
        progress = true;
      }
    }
  }
  for (const table of tables) {
    if (!done.has(table.name)) ordered.push(table);
  }
  return ordered;
}

/**
 * SQLite stored booleans as 0/1 integers and embeddings as a raw float32
 * buffer; Postgres wants a real boolean and pgvector's text form.
 */
function convert(value: unknown, kind: TableInfo["columns"][number]["kind"]): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "boolean") return value === 1 || value === true || value === "1";
  if (kind === "vector") {
    if (!Buffer.isBuffer(value)) return null;
    const floats = new Float32Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    return `[${Array.from(floats).join(",")}]`;
  }
  return value;
}

async function main(): Promise<void> {
  const sourceFile =
    process.argv[2] ?? new URL("../tuezday.db", import.meta.url).pathname;
  const targetUrl = process.argv[3] ?? resolveDatabaseUrl();

  const sqlite = new Database(sourceFile, { readonly: true });
  const present = new Set(
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const target = await createDb(targetUrl);
  console.log(`copying ${sourceFile} -> ${targetUrl.replace(/:[^:@/]*@/, ":***@")}`);

  let copied = 0;
  let skipped = 0;
  for (const table of copyOrder(describeTables())) {
    if (!present.has(table.name)) {
      skipped++;
      continue;
    }
    const sourceColumns = new Set(
      sqlite
        .prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const columns = table.columns.filter((c) => sourceColumns.has(c.sqlite));
    if (columns.length === 0) {
      skipped++;
      continue;
    }

    const rows = sqlite
      .prepare(
        `SELECT ${columns.map((c) => JSON.stringify(c.sqlite)).join(", ")} ` +
          `FROM ${JSON.stringify(table.name)}`,
      )
      .all() as Record<string, unknown>[];
    if (rows.length === 0) continue;

    for (let offset = 0; offset < rows.length; offset += BATCH) {
      const batch = rows.slice(offset, offset + BATCH);
      const values: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((column) => {
          values.push(convert(row[column.sqlite], column.kind));
          return `$${values.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await target.$pool.query(
        `INSERT INTO "${table.name}" (${columns.map((c) => `"${c.pg}"`).join(", ")}) ` +
          `VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
        values,
      );
    }
    copied += rows.length;
    console.log(`  ${table.name}: ${rows.length}`);
  }

  // Every bigserial the copy bypassed still points at 1; advance it past the
  // rows that were just written or the next insert collides.
  for (const table of describeTables()) {
    if (!present.has(table.name)) continue;
    await target.$pool
      .query(
        `SELECT setval(pg_get_serial_sequence($1, 'seq'), ` +
          `COALESCE((SELECT MAX(seq) FROM "${table.name}"), 1))`,
        [table.name],
      )
      .catch(() => {
        /* no seq column on this table */
      });
  }

  sqlite.close();
  await closeDb(target);
  console.log(`\ncopied ${copied} rows; ${skipped} tables had no source data`);
}

await main();
