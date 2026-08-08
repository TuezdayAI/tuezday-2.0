import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { createDb } from "./db";
import { DbEvidenceStore } from "./evidence/db-store";
import { createLlmGatewayFromEnv } from "./llm";
import { backfillCollections } from "./services/evidence";
import { parseDiscoveryOperatorPolicy } from "./runtime/operator-policy";
import { resolveDatabaseUrl } from "./runtime/database-url";
import { resolveHost } from "./runtime/host";
import { resolvePort } from "./runtime/port";
import { createShutdownHandler } from "./runtime/shutdown";
import { validateProductionEnv } from "./runtime/production-env";

// Load a root .env (gitignored) so GEMINI_API_KEY etc. reach the dev server
// without extra tooling. Existing env vars win.
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^["']|["']$/g, "").trim();
    // Skip blank assignments (unfilled .env.example lines) and never
    // override real environment variables.
    if (value && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = value;
    }
  }
}

const DATABASE_URL = resolveDatabaseUrl(process.env);
const PORT = resolvePort(process.env);
const HOST = resolveHost(process.env);
let operatorPolicy;
try {
  operatorPolicy = parseDiscoveryOperatorPolicy(process.env);
} catch (error) {
  const message =
    error instanceof Error ? error.message : "The policy is invalid.";
  console.error(`Invalid discovery operator configuration: ${message}`);
  process.exit(1);
}

// Fail fast in production: a container assembled from .env.example must not
// boot into a silently broken state (email/connectors/billing inert with no
// error). Development and tests are unaffected — see validateProductionEnv.
const { errors: productionEnvErrors, warnings: productionEnvWarnings } =
  validateProductionEnv(process.env);
for (const warning of productionEnvWarnings) {
  console.warn(warning);
}
if (productionEnvErrors.length > 0) {
  for (const error of productionEnvErrors) {
    console.error(error);
  }
  process.exit(1);
}

const db = await createDb(DATABASE_URL);
// One gateway instance shared by generation and the evidence store's
// embeddings (Sprint 47: evidence is native — no external service).
const llm = createLlmGatewayFromEnv();
const evidence = new DbEvidenceStore(db, llm);
const app = await buildApp({ db, llm, evidence, operatorPolicy });

// Docker sends SIGTERM, waits ten seconds, then SIGKILL. Without this, every
// container stop is a forced kill that severs in-flight requests and orphans
// the shared headless Chromium instance. app.close() fires app.ts's existing
// preClose/onClose hooks, which already handle both — this just calls it.
const shutdown = createShutdownHandler({
  close: () => app.close(),
  log: (message) => console.log(message),
  logError: (message, error) =>
    console.error(message, error instanceof Error ? error.message : error),
  exit: (code) => {
    process.exitCode = code;
  },
});
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Tuezday API listening on http://${HOST}:${PORT}`);
  // Best-effort on boot: ensure each workspace's evidence collection exists
  // and its ready documents are attached.
  void backfillCollections(db, evidence);
} catch (err) {
  console.error(err);
  process.exit(1);
}
