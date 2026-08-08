/**
 * Postgres plumbing shared by the global setup and the per-test harness.
 *
 * Tests run against a real Postgres (founder decision D-74.2) — there is no
 * in-process substitute for pgvector, tsvector ranking, `FOR UPDATE SKIP
 * LOCKED`, or Postgres' transaction semantics, and every one of those is
 * load-bearing somewhere in this codebase.
 *
 * Isolation is one database per fixture, cloned from a template that had the
 * migrations applied once for the whole run. `CREATE DATABASE ... TEMPLATE` is
 * a directory copy, so a fixture costs a few milliseconds instead of the ~130
 * CREATE TABLEs in the baseline. This preserves the property Sprint 73 bought
 * with the serialized-SQLite template: migrations execute once per run, not
 * once per test.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

/** The database every fixture is cloned from. Built once by the global setup. */
export const TEMPLATE_DB = "tuezday_test_template";
/** Fixture databases share this prefix so a crashed run can be swept clean. */
export const FIXTURE_PREFIX = "tuezday_t_";

/**
 * Base connection string. The database name in it is replaced per connection,
 * so only host/port/credentials matter here.
 */
export function baseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://tuezday:tuezday@localhost:5433/tuezday";
}

/** The same server, a different database. */
export function urlFor(database: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Identifiers are built here, never supplied by a caller, but quote them
 * anyway — CREATE DATABASE cannot be parameterised, so an unquoted identifier
 * is the one place this file could grow an injection.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A connection to the maintenance database. CREATE/DROP DATABASE cannot run
 * from inside the database being cloned or dropped.
 */
export async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: baseUrl() });
  await client.connect();
  return client;
}

/** Drop every database left over from an earlier run (or a crashed one). */
export async function dropFixtureDatabases(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${FIXTURE_PREFIX}%`],
  );
  for (const row of rows) {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)} WITH (FORCE)`);
  }
  return rows.length;
}

export function fixtureDatabaseName(): string {
  return `${FIXTURE_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
