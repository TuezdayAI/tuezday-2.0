import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { createDb } from "./db";
import { DbEvidenceStore } from "./evidence/db-store";
import { GeminiGateway } from "./llm/gemini";
import { backfillCollections } from "./services/evidence";

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

const DB_FILE = process.env.TUEZDAY_DB ?? "tuezday.db";
const PORT = Number(process.env.PORT ?? 3001);

const db = createDb(DB_FILE);
// One gateway instance shared by generation and the evidence store's
// embeddings (Sprint 47: evidence is native — no external service).
const llm = new GeminiGateway();
const evidence = new DbEvidenceStore(db, llm);
const app = await buildApp({ db, llm, evidence });

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`Tuezday API listening on http://localhost:${PORT}`);
  // Best-effort on boot: ensure each workspace's evidence collection exists
  // and its ready documents are attached.
  void backfillCollections(db, evidence);
} catch (err) {
  console.error(err);
  process.exit(1);
}
