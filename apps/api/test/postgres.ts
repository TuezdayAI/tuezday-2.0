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
import { closeDb, createDb, type Db } from "../src/db";

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

/**
 * Clone the template into a fresh fixture database.
 *
 * `STRATEGY = FILE_COPY` is the whole reason a fixture is affordable: the
 * PG15+ default (WAL_LOG) writes the entire 14MB template through WAL and
 * costs ~250ms, while a plain directory copy costs ~35ms. WAL_LOG exists so
 * the clone survives a crash and replicates — neither of which a database that
 * is dropped at the end of the test file needs. Postgres 14 and older do not
 * accept the clause, so the plain form is the fallback.
 */
export async function cloneTemplate(client: pg.Client, name: string): Promise<void> {
  const from = `${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DB)}`;
  try {
    await client.query(`CREATE DATABASE ${from} STRATEGY = FILE_COPY`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42601") throw err; // syntax_error
    await client.query(`CREATE DATABASE ${from}`);
  }
}

/**
 * The driver error behind a drizzle failure.
 *
 * drizzle wraps every query error as "Failed query: <sql>" and keeps the real
 * one on `cause`, so an assertion written against the message — a raised
 * exception, a constraint name — never matches unless it unwraps first.
 */
export function driverError(error: unknown): {
  message?: string;
  code?: string;
  constraint?: string;
} {
  return ((error as { cause?: unknown })?.cause ?? error) as {
    message?: string;
    code?: string;
    constraint?: string;
  };
}

/** Postgres SQLSTATEs the schema tests assert on. */
export const PG_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;

/**
 * Assert a write was refused by the database with a specific SQLSTATE.
 *
 * `.rejects.toThrow(/duplicate key/)` does not work here: drizzle wraps driver
 * errors, so the message is "Failed query: …" and the driver's message and
 * code live on `cause`. Matching the code is also stricter than matching
 * prose — "duplicate key" appears in messages for constraints this was not
 * asserting about.
 */
export async function expectPgError(
  work: Promise<unknown>,
  code: (typeof PG_ERROR)[keyof typeof PG_ERROR],
  constraint?: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`expected the database to refuse this write with SQLSTATE ${code}`);
  }
  const driver = driverError(thrown);
  if (driver.code !== code) {
    throw new Error(
      `expected SQLSTATE ${code}, got ${driver.code ?? "(none)"}: ${driver.message ?? String(thrown)}`,
    );
  }
  if (constraint !== undefined && driver.constraint !== constraint) {
    throw new Error(`expected constraint ${constraint}, got ${driver.constraint ?? "(none)"}`);
  }
}

/**
 * One maintenance connection per worker, opened on first use. Fixtures are
 * created constantly, and a fresh connect() per fixture would cost more than
 * the CREATE DATABASE it issues.
 */
let admin: Promise<pg.Client> | undefined;

/** Every fixture this worker opened, so the setup file can drop them per test file. */
const fixtures: { name: string; url: string; db: Db }[] = [];

/**
 * Fresh Postgres database with all checked-in migrations applied.
 *
 * Cloned from the template the global setup built, so this costs a directory
 * copy rather than replaying the baseline. The pool is small and drops idle
 * connections quickly: a full run opens hundreds of fixtures, and the server's
 * connection limit is the binding constraint, not throughput.
 */
export async function createTestDb(): Promise<Db> {
  const name = fixtureDatabaseName();
  admin ??= adminClient();
  await cloneTemplate(await admin, name);
  const url = urlFor(name);
  // Small pool with a short idle timeout: a run opens hundreds of fixtures and
  // holds each until its file ends, so the binding constraint is the server's
  // connection slots rather than per-fixture throughput.
  const db = await createDb(url, {
    migrated: true,
    max: 2,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
  fixtures.push({ name, url, db });
  return db;
}

/**
 * A second, independent pool onto an existing fixture: the Postgres equivalent
 * of two API processes opening the same database file. Restart and
 * two-instance-contention tests need genuinely separate connections, not a
 * second handle on the same one.
 */
export async function connectTestDbAgain(db: Db): Promise<Db> {
  const fixture = fixtures.find((f) => f.db === db);
  if (!fixture) throw new Error("connectTestDbAgain: not a fixture from createTestDb()");
  const second = await createDb(fixture.url, { migrated: true, max: 4 });
  // Same name: the drop below is IF EXISTS, so the repeat is a no-op.
  fixtures.push({ name: fixture.name, url: fixture.url, db: second });
  return second;
}

/**
 * Close and drop every fixture this worker opened. Called from the setup file's
 * afterAll, which runs once per test file.
 */
export async function dropTestDbs(): Promise<void> {
  const taken = fixtures.splice(0, fixtures.length);
  if (taken.length === 0) return;
  await Promise.all(taken.map(({ db }) => closeDb(db)));
  const client = await (admin ??= adminClient());
  for (const { name } of taken) {
    // FORCE: a test that leaked a connection should not wedge the whole run.
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  }
}

/** Close this worker's maintenance connection. */
export async function closeTestAdmin(): Promise<void> {
  if (!admin) return;
  const client = await admin;
  admin = undefined;
  await client.end().catch(() => {});
}
