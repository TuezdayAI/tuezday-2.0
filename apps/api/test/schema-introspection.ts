/**
 * Postgres catalog queries for the schema tests.
 *
 * Before Sprint 74 these assertions read `sqlite_master.sql` and pattern-matched
 * the stored CREATE statement. Postgres does not keep the original text, so the
 * equivalents here read the catalogs — which is stricter anyway: `pg_get_*def`
 * renders what the server actually enforces rather than what someone wrote.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../src/db";

export async function tableNames(db: Db): Promise<string[]> {
  const { rows } = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return rows.map((r) => r.table_name);
}

export async function columnNames(db: Db, table: string): Promise<string[]> {
  const { rows } = await db.execute<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `);
  return rows.map((r) => r.column_name);
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  /** The rendered DEFAULT expression, or null when the column has none. */
  default: string | null;
}

export async function columns(db: Db, table: string): Promise<ColumnInfo[]> {
  const { rows } = await db.execute<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `);
  return rows.map((r) => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === "YES",
    default: r.column_default,
  }));
}

export interface IndexInfo {
  name: string;
  /** The full CREATE INDEX statement as the server renders it. */
  definition: string;
}

export async function indexes(db: Db, table: string): Promise<IndexInfo[]> {
  const { rows } = await db.execute<{ indexname: string; indexdef: string }>(sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
    ORDER BY indexname
  `);
  return rows.map((r) => ({ name: r.indexname, definition: r.indexdef }));
}

export interface ConstraintInfo {
  name: string;
  /** e.g. `FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE`. */
  definition: string;
}

/** Table constraints — primary key, foreign key, unique, and check. */
export async function constraints(db: Db, table: string): Promise<ConstraintInfo[]> {
  const { rows } = await db.execute<{ conname: string; def: string }>(sql`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ${table}
    ORDER BY c.conname
  `);
  return rows.map((r) => ({ name: r.conname, definition: r.def }));
}

/** Every constraint definition on `table`, joined — handy for a `toContain`. */
export async function constraintText(db: Db, table: string): Promise<string> {
  return (await constraints(db, table)).map((c) => c.definition).join("\n");
}
