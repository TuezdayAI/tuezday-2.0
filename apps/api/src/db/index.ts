import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTransaction;

/**
 * The checked-in migration folder. Exported so the test suite can apply these
 * exact migrations once and clone the resulting schema per test, instead of
 * re-running all of them for every database it builds.
 */
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

/**
 * Open (or create) a SQLite database and bring it up to date with the
 * checked-in migrations. Pass ":memory:" for tests.
 */
export function createDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export { schema };
