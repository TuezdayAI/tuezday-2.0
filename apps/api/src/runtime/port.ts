/**
 * Resolves the API listen port from PORT. Unset, empty, or whitespace-only
 * reproduces today's "3001" behavior. This must never resolve to 0 —
 * `Number("")` is `0`, so a Docker `env_file` turning a bare `PORT=` line
 * into a set-but-empty variable would silently bind Fastify to a random
 * ephemeral port instead of the port the reverse proxy expects.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim();
  return raw ? Number(raw) : 3001;
}
