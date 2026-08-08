/**
 * Resolves the Postgres connection string from DATABASE_URL. Unset, empty, or
 * whitespace-only falls back to the local development server that
 * `npm run postgres:up` starts.
 *
 * The fallback is deliberately a loopback address so it cannot silently point
 * production at someone else's database: `production-env.ts` requires
 * DATABASE_URL explicitly, so a container never reaches this default. Before
 * Sprint 74 the same guard existed for a different reason — an empty path made
 * better-sqlite3 open an anonymous in-memory database and discard every write.
 */
export const DEFAULT_DATABASE_URL = "postgres://tuezday:tuezday@localhost:5433/tuezday";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATABASE_URL?.trim();
  return raw ? raw : DEFAULT_DATABASE_URL;
}
