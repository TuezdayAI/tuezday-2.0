import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $pool: pg.Pool };
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTransaction;

/**
 * The checked-in migration folder. Exported so the test suite can apply these
 * exact migrations once into a template database and clone it per test, instead
 * of re-running them for every database it builds.
 */
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

/**
 * Epoch-millisecond timestamps are stored in `bigint` columns (see schema.ts).
 * node-postgres returns int8 as a *string* by default to avoid precision loss;
 * epoch-ms is far inside Number.MAX_SAFE_INTEGER, so parse it back to a number
 * or every `createdAt` in the codebase would silently become a string.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
/** numeric/decimal — the schema uses double precision, but be explicit. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export interface CreateDbOptions {
  /** Skip `migrate()` — used when cloning an already-migrated template. */
  migrated?: boolean;
  /** Pool size; tests use a small pool because they open many databases. */
  max?: number;
}

/**
 * Open a Postgres pool and bring it up to date with the checked-in migrations.
 * `url` is a libpq connection string (`postgres://user:pass@host:port/db`).
 */
export async function createDb(url: string, options: CreateDbOptions = {}): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  // drizzle already exposes the pool as `$client`; `$pool` is the typed name
  // this codebase uses, so it is attached rather than cast over.
  const db = Object.assign(drizzle(pool, { schema }), { $pool: pool }) as Db;
  if (!options.migrated) {
    // The evidence store's embedding column is `vector(768)`, so the extension
    // has to exist before the baseline migration creates the table. drizzle-kit
    // does not emit CREATE EXTENSION, so it is issued here.
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await migrate(db, { migrationsFolder });
  }
  return db;
}

/**
 * Rows written by a statement. better-sqlite3 reported this as `changes:
 * number`; node-postgres types `rowCount` as nullable because a statement that
 * carries no row count (DDL, an empty multi-statement) reports none. No DML
 * does, so the fallback is unreachable — it exists so callers can do arithmetic
 * on the result without threading `number | null` through the fence checks.
 */
export function rowsAffected(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

/** Close the pool behind a Db. Safe to call more than once. */
export async function closeDb(db: Db): Promise<void> {
  await db.$pool.end().catch(() => {});
}

export { schema };
