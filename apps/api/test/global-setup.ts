/**
 * Vitest global setup — runs once per `npm test`, before any worker starts.
 *
 * Applies the checked-in migrations to a single template database that every
 * fixture is then cloned from, and sweeps away any fixture databases a crashed
 * run left behind.
 */
import { closeDb, createDb } from "../src/db";
import {
  TEMPLATE_DB,
  adminClient,
  dropFixtureDatabases,
  quoteIdent,
  urlFor,
} from "./postgres";

export async function setup(): Promise<void> {
  let admin;
  try {
    admin = await adminClient();
  } catch (err) {
    throw new Error(
      `Sprint 74: the API test suite needs a running Postgres. Start one with ` +
        `\`npm run postgres:up\` (or point DATABASE_URL at your own).\n` +
        `Connection failed: ${(err as Error).message}`,
    );
  }

  const swept = await dropFixtureDatabases(admin);
  if (swept > 0) console.log(`[postgres] swept ${swept} leftover fixture databases`);

  // Rebuild rather than reuse: a stale template is a schema drift bug that
  // only shows up as a mystifying failure three sprints later.
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DB)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DB)}`);
  await admin.end();

  const db = await createDb(urlFor(TEMPLATE_DB));
  await closeDb(db);
}

export async function teardown(): Promise<void> {
  const admin = await adminClient();
  await dropFixtureDatabases(admin);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DB)} WITH (FORCE)`);
  await admin.end();
}
