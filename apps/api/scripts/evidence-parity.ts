// Sprint 47 pre-cutover parity gate: run golden queries against BOTH the old
// R2R deployment and the native DbEvidenceStore on the same live corpus, and
// report overlap@5. Manual gate (needs Docker + a real corpus), not CI.
//
// Usage: npm run evidence:parity -- <workspace-id> [db-file]
// Requires: R2R up (R2R_BASE_URL, default http://localhost:7272), the
// workspace already migrated with `npm run evidence:migrate`, GEMINI_API_KEY
// for query embeddings.
//
// Bar (spec §5): average overlap@5 ≥ 0.6 and no query with zero overlap.

import { eq } from "drizzle-orm";
import { createDb } from "../src/db/index";
import { evidenceCollections, evidenceDocuments } from "../src/db/schema";
import { DbEvidenceStore } from "../src/evidence/db-store";
import { GeminiGateway } from "../src/llm/gemini";

const GOLDEN_QUERIES = [
  "what is our pricing and what does each plan cost",
  "who is our ideal customer profile",
  "why do customers churn and when",
  "how do we compare against competitors",
  "what tone of voice do we write in",
  "what did we learn from the last product launch",
  "how do we handle pricing objections in outreach",
  "what results and metrics can we cite publicly",
  "which channels perform best for us",
  "what is our positioning against the incumbent stack",
  "what integrations do customers ask for",
  "what does onboarding look like for a new customer",
];

const K = 5;

interface R2RSearchBody {
  results?: {
    chunk_search_results?: { text?: string; document_id?: string }[];
  };
}

/** Minimal R2R v3 search — the deployment being retired; inline so the app
 * carries no R2R client code. */
async function r2rSearch(
  baseUrl: string,
  query: string,
  collectionId: string,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/v3/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      search_settings: {
        limit: K,
        filters: { collection_ids: { $overlap: [collectionId] } },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`R2R search returned ${res.status}`);
  const body = (await res.json()) as R2RSearchBody;
  return (body.results?.chunk_search_results ?? []).map((c) => normalize(c.text ?? ""));
}

/** Compare on normalized text prefixes — document ids differ across stores. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error("Usage: npm run evidence:parity -- <workspace-id> [db-file]");
  process.exit(1);
}
const dbFile = process.argv[3] ?? new URL("../tuezday.db", import.meta.url).pathname;
const r2rBaseUrl = (process.env.R2R_BASE_URL?.trim() || "http://localhost:7272").replace(/\/$/, "");

const db = createDb(dbFile);
const store = new DbEvidenceStore(db, new GeminiGateway());

const collection = db
  .select()
  .from(evidenceCollections)
  .where(eq(evidenceCollections.workspaceId, workspaceId))
  .get();
if (!collection) {
  console.error(`No evidence collection for workspace ${workspaceId}.`);
  process.exit(1);
}
const docCount = db
  .select()
  .from(evidenceDocuments)
  .where(eq(evidenceDocuments.workspaceId, workspaceId))
  .all()
  .filter((d) => d.status === "ready").length;
console.log(`Workspace ${workspaceId}: ${docCount} ready documents. Comparing top-${K}…\n`);

// The R2R side still needs ITS collection id; after migration our table holds
// the native id, so ask R2R for a collection whose name is the workspace id.
async function r2rCollectionId(): Promise<string | null> {
  const res = await fetch(`${r2rBaseUrl}/v3/collections?limit=100`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: { id?: string; name?: string }[] };
  return body.results?.find((c) => c.name === workspaceId)?.id ?? null;
}

const r2rCol = await r2rCollectionId();
if (!r2rCol) {
  console.error("Could not find the R2R collection for this workspace — is R2R up?");
  process.exit(1);
}

let totalOverlap = 0;
let zeroOverlapQueries = 0;
for (const query of GOLDEN_QUERIES) {
  const [oldTop, nativeResults] = await Promise.all([
    r2rSearch(r2rBaseUrl, query, r2rCol),
    store.search(query, collection.r2rCollectionId, K),
  ]);
  const nativeTop = nativeResults.map((r) => normalize(r.text));
  const overlap =
    oldTop.length === 0
      ? 1 // nothing to miss
      : oldTop.filter((t) => nativeTop.some((n) => n.includes(t.slice(0, 60)) || t.includes(n.slice(0, 60)))).length /
        oldTop.length;
  totalOverlap += overlap;
  if (overlap === 0 && oldTop.length > 0) zeroOverlapQueries++;
  console.log(`${overlap.toFixed(2)}  ${query}`);
}

const avg = totalOverlap / GOLDEN_QUERIES.length;
console.log(`\nAverage overlap@${K}: ${avg.toFixed(2)} (bar ≥ 0.60, zero-overlap queries: ${zeroOverlapQueries})`);
if (avg < 0.6 || zeroOverlapQueries > 0) {
  console.error("PARITY BAR NOT MET — tune before cutover (chunk size, RRF k, FTS query building).");
  process.exit(1);
}
console.log("Parity bar met.");
