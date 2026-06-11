# Spec: Sprint 9 — RAG Corpus (R2R)

> Status: in build
> Covers Phase 7 of the rebuild plan, milestone M7. First external OSS service, integrated strictly behind the Brain Gateway boundary per `oss-integration-recommendations.md`: R2R owns parsing/chunking/embedding/retrieval mechanics; **Tuezday owns the evidence vocabulary, retrieval policy, prompt packing, and the citations UI.**

## What this slice does

The founder uploads evidence — website copy, past posts, research notes, call summaries — as titled text documents. R2R ingests them (chunking + Gemini embeddings). When resolving/generating, Tuezday builds a retrieval query from the task's context (signal first, then campaign objective, then `now`/soul), asks R2R for the most relevant chunks **scoped to this workspace's documents**, and injects them as a cited `evidence` section in the context bundle — readable before any LLM call, traced like every other layer, and rendered with sources in the UI.

## Out of scope

Graphiti/Mem0 (explicitly deferred by plan), URL/file scraping (paste text only — file upload later), the app-DB Postgres swap (R2R brings its own Postgres container; migrating Tuezday's SQLite is deferred to its own slice — schema remains portable), auto-syncing sources, R2R collections/users (single-tenant local; workspace scoping via our own document-id mapping).

## Deployment

`infra/r2r/compose.yaml` (ours — R2R code never enters the repo, only their published images): `sciphiai/r2r:latest` + `pgvector/pgvector:pg16`, configured with R2R's **built-in `gemini.toml`** (`R2R_CONFIG_NAME=gemini`) and the existing `GEMINI_API_KEY` from the root `.env`. R2R API on :7272; its Postgres on :5433 (avoiding clashes). npm scripts: `npm run r2r:up` / `npm run r2r:down`. The app degrades gracefully when R2R is down — evidence endpoints report status, resolution proceeds without evidence and says so in the trace.

## Behavior

### Boundary (`apps/api/src/evidence/`)

`EvidenceStore` interface (health, addDocument, deleteDocument, search) with the R2R REST implementation (`POST /v3/documents` multipart raw_text, `DELETE /v3/documents/:id`, `POST /v3/retrieval/search` with `document_id $in` filters, `GET /v3/health`). Injectable into `buildApp` (tests use a fake; the fetcher is injectable inside the client too). Base URL from `R2R_BASE_URL` (default `http://localhost:7272`).

### Data

`evidence_documents`: id, workspaceId, r2rDocumentId (nullable until ingested), title (1–200), chars, status (`processing` | `ready` | `failed`), error (nullable), createdAt. Workspace scoping happens in Tuezday: searches filter by the workspace's r2r document ids — no cross-workspace leakage even though R2R is single-tenant.

### Retrieval policy (Tuezday-owned, deterministic)

Query composition priority: signal content (truncated) → campaign objective → `now` doc excerpt → soul excerpt; plus task type and channel keywords. Top 5 chunks, relevance floor 0.35. Evidence retrieval runs only when the request allows it (`useEvidence`, default true), the store is healthy, and the workspace has ready documents.

### Resolver

New `evidence` layer in `packages/brain` (after `signal`, before `task`): chunks rendered with `[n]` markers and a source list (`[n] Title`), section reason names the retrieval query. Absent → excluded with an explicit reason (no docs / store down / evidence off). The task instructions are extended: when evidence is present, ground claims in it.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/evidence` | `{title, content (≤200k chars)}` → ingest into R2R with workspace metadata, row `ready`/`failed`. `503 evidence_store_unavailable` if R2R is down. |
| `GET /workspaces/:id/evidence` | list newest first + store status `{healthy, detail?}`. |
| `DELETE /workspaces/:id/evidence/:documentId` | removes from R2R + our table. |
| resolve / generate / signal-draft | gain `useEvidence?: boolean` (default true); evidence chunks flow into the bundle when available. |

### Web

- `/workspaces/[id]/evidence`: store status banner (with `npm run r2r:up` hint when down), paste-a-document form, list with status/chars/delete.
- Resolver + sandbox: "Use evidence" toggle; the evidence section shows cited chunks with sources like every other section.
- Sandbox output: generations store their full section trace already — the evidence the model saw is inspectable per generation.

## Automated verification

- Brain: evidence section ordering/citation rendering/exclusion reasons; instruction grounding line.
- R2R client: request shapes (multipart raw_text, search filters, delete path) and response parsing against fixture fetcher; health failure mapping.
- API (fake store): upload happy/failed paths; list with status; delete; retrieval policy query composition (signal beats campaign beats now); resolve/generate include evidence with `useEvidence` true, exclude when false/store-down/no-docs (with correct trace reasons); workspace scoping (only this workspace's doc ids in filters).

## Founder acceptance checklist (M7 gate)

1. `npm run r2r:up`, wait for healthy, upload your website copy + 2–3 past posts as evidence.
2. Resolve a task — the evidence section shows relevant cited chunks and the trace explains the query.
3. Generate — the output uses the evidence; the stored trace shows exactly which chunks the model saw.
4. Stop R2R — the app keeps working, evidence section says why it's excluded.
5. Delete a document — it stops appearing in retrieval.
