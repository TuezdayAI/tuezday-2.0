# Spec: Sprint 2 — Central Brain v0

> Status: in build
> Covers rebuild-plan tickets 4–6 (brain document model/API/tests, brain editor UI, version history + export + completeness score). Phase 1 of the rebuild plan, milestone M1.

## What this slice does

Every workspace owns five human-readable brain documents — `soul`, `icp`, `voice`, `history`, `now`. The founder can read and edit each one in a markdown editor, see every saved version, see how complete the brain is, and export the whole brain as one coherent markdown document.

## Out of scope

Personas, overlays, context resolution (Sprint 3), generation (Sprint 4), RAG, any LLM call. The brain is plain editable text — no AI touches it in this sprint.

## Behavior

### Data

- `brain_documents`: one row per (workspace, docType), unique. Auto-created empty for all five types when a workspace is created (and lazily ensured on read for pre-existing workspaces). Cascade-deleted with the workspace.
- `brain_document_versions`: append-only. Every successful save of a document inserts a version row with the saved content and an incrementing version number (first save = version 1). Creating the empty doc records no version.

### New package: `packages/brain`

Pure, deterministic brain logic shared by API and web (this starts the planned `packages/brain` home for docs/overlays/resolution):

- **Doc metadata**: canonical order, display titles, and one-line descriptions for the five doc types (e.g. `soul` → "Soul — why we exist").
- **Completeness scoring**: per doc, by trimmed word count — `empty` (0 words), `draft` (1–39), `complete` (≥40; threshold is a named constant). Workspace score = (empty 0, draft 0.5, complete 1 per doc) / 5, as a percent.
- **Markdown export rendering**: workspace name heading + the five docs in canonical order with their titles; unwritten docs render as "_Not written yet._".

### API (`apps/api`)

| Endpoint | Behavior |
|---|---|
| `GET /workspaces/:id/brain` | `200 { docs: BrainDocument[5] (canonical order), completeness }`. `404` unknown workspace. |
| `PUT /workspaces/:id/brain/:docType` | body `{content: string ≤ 50,000 chars}` → `200` updated doc; inserts a version row; bumps `updatedAt`. `400` invalid body or unknown docType, `404` unknown workspace. |
| `GET /workspaces/:id/brain/:docType/versions` | `200` version list, newest first. `400`/`404` as above. |
| `GET /workspaces/:id/brain/export` | `200` `text/markdown` full-brain export. `404` unknown workspace. |

### Web (`apps/web`)

- Workspace cards on the dashboard link to `/workspaces/[id]`.
- Brain page: sidebar with the five docs (title + completeness state), editor pane with textarea + save, unsaved-changes indicator, workspace completeness percent, "Export brain" link to the API export, and a version history panel per doc (view a prior version, restore it — restore is just a save of that content).

## Automated verification

- `packages/brain` tests: completeness thresholds and scoring, export rendering (order, titles, empty-doc placeholder).
- API tests: auto-creation of five docs on workspace create; lazy ensure on read; canonical order; save → version 1, second save → version 2; updatedAt bump; validation (unknown docType, oversized content, missing content); 404s; versions newest first; export contains workspace name and all five sections.

## Founder acceptance checklist (M1 gate)

1. Open a workspace → five docs are there, all empty, completeness 0%.
2. Fill all five docs → completeness rises to 100%.
3. Edit one doc twice → version history shows both saves, newest first; restoring an old version works.
4. Export the brain → one coherent markdown document you'd be happy to read aloud.
