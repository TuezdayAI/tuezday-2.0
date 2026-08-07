/**
 * Resolves the SQLite database file path from TUEZDAY_DB. Unset, empty, or
 * whitespace-only reproduces today's "tuezday.db relative to the process's
 * working directory" behavior. This must never resolve to "" — better-
 * sqlite3 treats an empty path as an anonymous **in-memory** database, so a
 * Docker `env_file` turning a bare `TUEZDAY_DB=` line into a set-but-empty
 * variable would silently discard all data on every restart instead of
 * failing loudly.
 */
export function resolveDbFile(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TUEZDAY_DB?.trim();
  return raw ? raw : "tuezday.db";
}
