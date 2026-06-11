# Spec: Sprint 10 — Learning Loop

> Status: in build
> Covers Phase 9 of the rebuild plan, milestone M9. The compounding mechanism: approval decisions, edits, ratings, and engagement metrics become a reviewed update to the `now` doc — the system gets sharper because every outcome has somewhere to go.

## What this slice does

Tuezday assembles **training examples** from what already happened (ratings on generations; approve/reject/edit decisions on drafts, including what the founder changed), accepts **engagement metrics** for shipped content (manual entry first — no analytics integrations yet), and on demand (or weekly via the worker) **synthesizes a proposed `now` update** through the LLM gateway: what's working, what isn't, what to lean into. The proposal sits in a review queue — **nothing touches the brain without founder acceptance**. Accepting appends a dated learnings block to `now` (versioned like any brain edit, feeding every future resolution).

## Out of scope

Automatic metric sync (PostHog/Airbyte arrive with later integration sprints), auto-applying syntheses, per-example fine-tuning, editing proposals inline (accept or dismiss; the `now` doc itself stays editable in the brain editor).

## Behavior

### Training examples (derived, no new storage)

Assembled deterministically from existing data: every rated generation (`accepted`/`needs_edit`/`rejected` + output) and every decided draft (final content, original content when edited, decision, task/channel/persona/campaign, source signal). Exposed at `GET /learning/examples` and shown in the UI — the founder can see exactly what the system will learn from.

### Engagement metrics

`engagement_metrics` table: id, workspaceId, draftId (nullable — usually an approved draft), channel, description, impressions / engagements / clicks (nullable ints ≥ 0), notes, recordedAt (defaults now), createdAt. `POST /metrics` + `GET /metrics`. UI offers a metrics form on approved drafts.

### Synthesis

`POST /learning/synthesize`: gathers a stats digest (rating counts, decision counts, edit rate), up to ~20 most recent training examples (with edit diffs), all metrics, and the current `now` doc; prompts the gateway for a **concise learnings block** (markdown, ≤ ~250 words) plus a one-paragraph rationale. Stored in `now_syntheses`: id, workspaceId, proposal, rationale, basedOnJson (counts used), status `proposed` | `accepted` | `dismissed`, createdAt, decidedAt. `409 nothing_to_learn` when there are no decisions/ratings/metrics at all.

- `POST /learning/syntheses/:id/accept` → appends `\n\n## Learnings (synthesized <date>)\n\n<proposal>` to the `now` doc via the standard brain update path (creates a version, bumps completeness), marks `accepted`. The resolver picks it up immediately.
- `POST /learning/syntheses/:id/dismiss` → `dismissed`.
- Deciding twice → `409`.

### Worker

On its existing tick: if a workspace has no `proposed` synthesis and the newest synthesis (any status) is older than `LEARNING_SYNTHESIS_DAYS` (default 7), trigger one — the plan's "weekly synthesis". Failures log and retry next tick; the founder still reviews everything.

### Web (`/workspaces/[id]/learning`)

1. Stats row: ratings breakdown, decisions breakdown, edit rate, metrics count.
2. Synthesis panel: "Synthesize learnings" button; proposals newest first — proposed ones show proposal + rationale + **Accept into `now`** / **Dismiss**; accepted ones link to the brain editor.
3. Training examples list (expandable; edited drafts show original vs final).
4. Metrics: approved drafts with an inline add-metrics form + recorded metrics list.

## Automated verification

- Contracts: metric/synthesis schema validation.
- API (fake gateway): examples derivation (rated generation appears; edited-then-approved draft carries original + final; undecided drafts excluded); metrics CRUD + validation; synthesize prompt contains stats/examples/metrics and stores proposal; nothing-to-learn 409; accept appends to `now` + creates a brain version + flips status; dismiss; double-decide 409; worker-style trigger conditions via the API surface.

## Founder acceptance checklist (M9 gate)

1. You already have rated generations and approve/reject/edit history — open Learning and see them as training examples.
2. Add real metrics to an approved post you actually shipped.
3. Synthesize → read the proposal and rationale. The gate question: **do you trust it enough to put into your brain?**
4. Accept it → `now` gains a dated learnings block (check the brain editor and version history).
5. Resolve any task → the learnings now appear in the context bundle.
