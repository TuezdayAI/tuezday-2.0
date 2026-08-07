/**
 * Resolves the bind host from HOST. Development must stay closed by default —
 * only an explicit HOST (e.g. `0.0.0.0`, to accept connections from a
 * container's reverse proxy) opens the listener beyond loopback. Unset,
 * empty, or whitespace-only reproduces today's "127.0.0.1 only" behavior.
 */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HOST?.trim();
  return raw ? raw : "127.0.0.1";
}
