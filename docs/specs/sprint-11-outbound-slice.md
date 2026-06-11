# Spec: Sprint 11 — Outbound Slice

> Status: in build
> Covers Phase 10 of the rebuild plan, milestone M10. The second proof module: the same brain, resolver, approval gate, and learning loop now drive outbound. Sending infrastructure is explicitly out of scope forever (Smartlead/Instantly arrive behind the connector fabric).

## What this slice does

The founder imports leads (CSV paste or one-by-one), selects some, and Tuezday drafts a **personalized outbound email per lead** — resolved through the full brain pipeline with a new `lead` context layer (name, company, role, notes), persona, optional campaign, and evidence. Every draft lands in the existing approval queue. Approved outbound drafts export as a CSV (lead + email + content) ready for any sending tool.

## Out of scope

Sending/deliverability/warmup (never ours), email verification, lead enrichment (Apollo/Clay arrive as integrations), sequences/multi-step cadences (one opener per lead for v1), reply handling.

## Behavior

### Leads

`leads` table: id, workspaceId, name (1–200), email (validated), company / role (≤200, optional), notes (≤2000, optional — context the founder knows: "met at SaaStr", "complained about AI slop on LinkedIn"), createdAt.

- `POST /leads` single create; `GET /leads` newest first; `DELETE /leads/:leadId`.
- `POST /leads/import` body `{csv}`: header-aware parsing (name/email/company/role/notes columns in any order, quoted fields supported), skips rows without a valid email, dedupes against existing emails (case-insensitive). Returns `{imported, skipped, errors[]}`.

### Resolver: `lead` layer + `outbound_email` task

New task type `outbound_email` (instruction: subject line + short personalized email, grounded in real lead facts — **no invented personalization**; only reference what the lead data actually says). New `lead` layer slotted **after persona, before signal** (always present; excluded with a reason when absent, like every slot). Content: who the email is to — name, company, role, founder notes.

### Batch drafting

`POST /outbound/draft` body `{leadIds (1–25), personaId?, campaignId?, tokenBudget?, useEvidence?}`: per lead — resolve with the lead layer, generate, store the generation (training log), submit a draft straight into `pending_review` with `leadId` linked (generations and drafts gain nullable `leadId`). Per-lead provider failures don't abort the batch; the response lists per-lead `{leadId, draftId?, generationId?, error?}`.

### Export

`GET /outbound/export.csv` (optional `?state=`, default `approved`): CSV with proper quoting — `name,email,company,role,channel,content` for lead-linked drafts in that state, served as a download. Copy/download per draft already exists in the queue.

### Web (`/workspaces/[id]/outbound`)

1. Import panel: CSV paste textarea (+ example header), import result; single-lead add form.
2. Lead list with checkboxes; per-lead draft chain (state badges → approval queue).
3. "Draft outbound emails" bar: persona / campaign / evidence controls + selected count.
4. "Export approved CSV" button.
5. Nav links; the approval queue already shows these drafts (new task label).

## Automated verification

- Contracts: lead schemas, email validation, import input, batch request bounds.
- Brain: lead section placement/content/exclusion; `outbound_email` instruction exists and forbids invented personalization.
- API: lead CRUD; CSV import (header order variance, quoted commas, invalid-email skip, duplicate dedupe); batch draft creates per-lead pending_review drafts with linked leadId and lead facts in the prompt; per-lead failure tolerance; export CSV correctness (only requested state, escaping, only lead-linked drafts).

## Founder acceptance checklist (M10 gate)

1. Import 5 real-ish leads via CSV paste.
2. Select them → draft as CEO under a campaign.
3. Read the drafts: personalization must come from the lead data, not hallucinated flattery.
4. Edit one, approve a few, reject one — the same queue you already trust.
5. Export the approved CSV and open it — ready for any sender.
