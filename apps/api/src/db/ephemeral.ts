/**
 * A throwaway database on the configured Postgres server.
 *
 * The eval harness needs a disposable workspace to run a suite against — it
 * used to get one from SQLite's `:memory:`, which Postgres has no equivalent
 * of. This creates a real database, migrates it, and drops it on release.
 *
 * Only CLI harnesses (`npm run eval`, `npm run evidence:parity`) use this. The
 * server never does: it connects to the database it was given.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { closeDb, createDb, type Db } from "./index";
import { resolveDatabaseUrl } from "../runtime/database-url";

export interface EphemeralDb {
  db: Db;
  name: string;
  /** Close the pool and drop the database. Safe to call more than once. */
  release(): Promise<void>;
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createEphemeralDb(baseUrl = resolveDatabaseUrl()): Promise<EphemeralDb> {
  const name = `tuezday_tmp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  // The name is generated here, never supplied by a caller, but CREATE DATABASE
  // takes no parameters so quote it anyway.
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const db = await createDb(urlFor(baseUrl, name));
  let released = false;
  return {
    db,
    name,
    async release() {
      if (released) return;
      released = true;
      await closeDb(db);
      const client = new pg.Client({ connectionString: baseUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await client.end();
    },
  };
}
