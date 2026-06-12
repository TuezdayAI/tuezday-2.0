# Spec: Sprint 16 — PR & Media Outreach

> Status: built, awaiting founder acceptance
> Third proof that a new module is just the same brain + approval gate pointed at a new audience. Structurally a sibling of the Outbound slice (Sprint 11): a contact table + CSV import on one side, the resolver and approval queue in the middle, CSV/email-client export on the other. The audience changes everything else — the contact is a journalist with a beat, the channel guidance is "you are pitching someone who triages 200 emails a day", and the brain layers that matter most flip from `icp`/`voice` to `history` (proof points) and `now` (the news hook). No media-database integration, no sending infra — same rule as outbound.

## What this slice does

1. **Media contact model + CSV import.** A `media_contacts` table (journalist / publication / podcast: name, email, outlet, beat, past coverage notes) with the same CRUD + CSV import machinery as leads — header aliasing, RFC-4180 quoting, dedupe by email. No Muck Rack / media-database integration yet; the founder's spreadsheet is the source.
2. **PR pitch types, not a new campaign model.** A pitch is one of three types — `announcement`, `thought_leadership`, `reactive` — chosen at draft time. Campaigns stay exactly what they are (overlay context); a "PR campaign" is a normal campaign whose overlay carries the announcement/launch framing, selected on the pitch panel like everywhere else. The pitch type selects a composed task instruction (same `taskInstruction` override mechanism Sprint 15 added), so what changes per type is visible in the context trace, not buried in code.
3. **Brain-personalized pitch drafts per contact.** Batch generation mirrors outbound: pick contacts (1–25), pitch type, optional campaign/persona (persona = founder voice), one LLM call per contact, per-contact fault tolerance. The resolver gets a new `mediaContact` section (sibling of `lead`) carrying name, type, outlet, beat, and coverage notes — the prompt can reference the contact's beat and may personalize **only** from those facts. New channel `pr` with built-in guidance written for media pitching.
4. **Signal-to-PR path.** A `reactive` pitch requires a signal: any signal in the workspace — including ones triaged in from the Discovery inbox (Sprint 9) — can be picked on the pitch panel. The signal lands in the resolver's existing signal section and the draft carries `sourceSignalId`, so a discovered story becomes a timely founder-comment pitch with full provenance.
5. **Press kit / boilerplate.** One click generates press boilerplate (one-liner, ~100-word about paragraph, key facts) from the brain docs through the same resolve → generate → approve loop. It is a draft like any other (`press_boilerplate` task type): editable in the queue, versioned by the approval decision log, re-generatable any time the brain changes.
6. **Approval queue reuse + export.** Pitches and boilerplate land in the existing queue as `pending_review` drafts — zero schema change to the gate. Approved pitches export as CSV (contact fields + content) and per-pitch via a `mailto:` link that opens the founder's email client with subject and body pre-filled. **No sending infra.**

Founder-visible chain: import 5 media contacts → pick a campaign + pitch type → Draft pitches → each pitch references that contact's beat in the workspace voice → edit/approve in the queue → export CSV or open in the email client and send by hand.

## Out of scope

Media-database integrations (Muck Rack, Prowly — a later connector), email sending/tracking (same rule as outbound: never build sending infra in this slice), press-release long-form documents (boilerplate only; full releases are a content-module concern), podcast booking workflows, HARO/Qwoted-style request monitoring (Discovery sources can cover this later), contact enrichment/scraping, PR-specific analytics.

## Behavior

### Contracts (`packages/contracts`)

- `CHANNELS` gains `"pr"`. `TASK_TYPES` gains `"pr_pitch"` and `"press_boilerplate"`.
- `MEDIA_CONTACT_TYPES = ["journalist", "publication", "podcast"]`.
- `mediaContactSchema`: `{ id, workspaceId, name (1–200), email, type (MEDIA_CONTACT_TYPES), outlet (≤200), beat (≤200), coverageNotes (≤2000), createdAt }`. `createMediaContactInputSchema` mirrors it (type defaults to `journalist`, outlet/beat/coverageNotes default `""`). `importMediaContactsInputSchema`: `{ csv (≤500KB) }`.
- `PR_PITCH_TYPES = ["announcement", "thought_leadership", "reactive"]` + `PrPitchType`.
- `prPitchRequestSchema`: `{ contactIds (1–25 uuids), pitchType, signalId?, personaId?, campaignId?, tokenBudget?, useEvidence? }`, refined so `reactive` **requires** `signalId` and the other two types **reject** one (a stale signal silently steering an announcement pitch is a footgun).
- `pressKitRequestSchema`: `{ personaId?, campaignId?, tokenBudget?, useEvidence? }`.
- `draftSchema` and `generationSchema` gain `mediaContactId: uuid | null` — the same linkage pattern `leadId` uses.

### Resolver (`packages/brain`)

- `CHANNEL_GUIDANCE.pr` — written for the actual reader: a journalist triaging a full inbox. Subject line is the story; lead with why their readers care; short, factual, zero marketing language; never call your own news exciting.
- `ResolveInput` gains `mediaContact?: { name, type, outlet, beat, coverageNotes }`. New section key `media_contact` (layer `"contact"`), placed after `lead`, included when present with the contact facts and a trace reason instructing personalization **only** from those facts (never invent past coverage or relationships); excluded with a reason otherwise — exactly the lead-section pattern.
- `composePrPitchInstruction(pitchType)` exported: a shared spine (subject line prefixed `Subject: `, body ≤150 words, personalize only from the contact facts, one clear low-friction ask, no flattery or superlatives) plus a per-type angle —
  - `announcement`: frame the company's news (the campaign overlay / `now` doc carries it) as a story for this contact's beat and outlet's readers;
  - `thought_leadership`: pitch the persona as a source — one sharp, earned point of view from `history`/`soul` relevant to the contact's beat, offered as expert comment or a contributed piece;
  - `reactive`: respond to the market signal — offer the founder's specific take on the developing story, connect it to the contact's beat, make the timeliness explicit.
- `TASK_INSTRUCTIONS` gains static defaults: `pr_pitch` (the announcement composition) and `press_boilerplate` (labeled parts — `One-liner:`, `About:` ~100 words third-person factual, `Key facts:` 3–5 bullets — every claim grounded in context, never invented).

### Endpoints (`apps/api/src/routes/pr.ts`)

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/media-contacts` | Create one contact (400 invalid, 201). Email lowercased. |
| `GET /workspaces/:id/media-contacts` | List, newest first. |
| `DELETE /workspaces/:id/media-contacts/:contactId` | 204, 404 unknown. |
| `POST /workspaces/:id/media-contacts/import` | CSV import: header aliasing (`outlet`/`publication`/`show`, `beat`/`coverage area`/`topics`, `coverage notes`/`notes`, `type`), unknown `type` values fall back to `journalist`, dedupe by email against existing + within file, per-row validation, returns `{ imported, skipped, errors }`. |
| `POST /workspaces/:id/pr/pitch` | Validates input (400) including the reactive/signal pairing; persona/campaign/signal/contact must exist (404), archived campaign 409. One evidence retrieval per batch (campaign objective + signal content feed the query). Per contact: resolve context (taskType `pr_pitch`, channel `pr`, `mediaContact` section, signal section when reactive, `taskInstruction` composed from the pitch type) → LLM → store generation + submit draft (`pending_review`) carrying `mediaContactId`, `sourceSignalId`, campaign/persona. Per-contact `GatewayError`s land in the results array without aborting the batch. Returns `{ results: [{ contactId, generationId?, draftId?, error? }] }`. |
| `POST /workspaces/:id/pr/press-kit` | Same validation; resolves (taskType `press_boilerplate`, channel `pr`, no contact/signal) → one LLM call → generation + draft → 201 draft. Gateway failure → 502 `generation_failed`. Each regeneration is a new draft — the run of `press_boilerplate` drafts plus each draft's decision log is the version history. |
| `GET /workspaces/:id/pr/export.csv?state=approved` | Drafts with `mediaContactId` set, in the requested state (400 unknown). Columns `name,email,type,outlet,beat,content`, standard `csvField` escaping, attachment `tuezday-pr-<state>.csv`. Outbound's export keys on `leadId`, this one on `mediaContactId` — the two never leak into each other. |

`storeGeneration` / `submitDraft` gain an optional `mediaContactId` (null everywhere else). The approval gate itself is untouched — no new states, no format enforcement (pitches are prose, not constrained fields).

### Web

- **`/workspaces/[id]/pr`** (new page; nav: child of **Audience**, next to CRM):
  - Contacts: paste-CSV import + add-one form (name, email, type, outlet, beat, notes) + list with type/outlet/beat visible, checkbox per contact, delete.
  - Pitch panel: pitch type (announcement / thought leadership / reactive), campaign + persona selects, signal select (shown and required only for reactive, listing workspace signals newest first), "Use evidence", **Draft N pitches**.
  - Pitches: per-contact drafts shown with state badges; approved pitches get **copy**, **Open in email client** (`mailto:` with subject/body split out of the draft), and the export bar (state → CSV).
  - Press kit: Generate button + the `press_boilerplate` draft history (newest first, state badges), edit/approve via the queue like everything else.
- **Approvals page**: no behavior change; add human labels for the two new task types so PR drafts read properly in the queue (same for the label maps on the resolver, sandbox, and learning pages).
- **Sandbox page**: `pr_pitch` is filtered out of the task-type dropdown (a pitch without a contact is meaningless — same reasoning as ad creatives); `press_boilerplate` stays available (it is exactly a sandbox-shaped task).
- **Resolver inspector**: nothing to do — new task types/channel appear automatically from the contract enums.

### DB (`apps/api`, migration 0014)

- New table `media_contacts`: `id`, `workspace_id` (FK, cascade), `name`, `email`, `type` (default `journalist`), `outlet`/`beat` (default `""`), `coverage_notes` (default `""`), `created_at`.
- `drafts` and `generations` gain nullable `media_contact_id`.

## Automated verification

- **Contracts:** new enum members present (`pr` channel, both task types, contact types); media contact create validation (bad email, long beat); `prPitchRequestSchema` — reactive without signal rejected, announcement/thought-leadership with signal rejected, reactive with signal accepted, contactIds bounds (0 and 26 rejected).
- **Resolver:** media contact section included with name/outlet/beat/notes in content and in the prompt; placeholder excluded with reason when absent; section order (after lead, before signal); `composePrPitchInstruction` differs per type and each mentions its angle (announcement/news, source/point of view, signal/timely); static `TASK_INSTRUCTIONS` entries exist for both new types; `pr` channel guidance exists.
- **API (fake LLM):** contacts CRUD; CSV import with quoted fields, aliased headers (`publication` → outlet, `topics` → beat), unknown type falling back to journalist, email dedupe within file and against existing rows; pitch batch creates one generation + one `pending_review` draft per contact with taskType `pr_pitch`, channel `pr`, `mediaContactId` set, contact beat/outlet present in the stored prompt; persona/campaign carried onto drafts; archived campaign 409, unknown contact/persona/signal 404; per-contact gateway failure tolerated; reactive pitch embeds the signal content in the prompt and stamps `sourceSignalId`; non-reactive with `signalId` is a 400; press kit creates a `press_boilerplate` draft (201) and a second call creates a second draft (version history); export defaults to approved-only, escapes commas/quotes, includes contact fields, excludes lead-linked outbound drafts, and the outbound export conversely never includes pitch drafts.

## Founder acceptance checklist

1. PR page → paste a 5-contact CSV (mixed journalists/podcasts, quoted fields) → 5 contacts appear with outlet and beat; re-import skips them all as duplicates.
2. Select all 5 → pitch type **announcement** + your launch campaign + founder persona → Draft pitches → 5 drafts, each referencing that contact's actual beat, in the workspace voice, nothing invented.
3. Open one in **Review & approve** → edit a line → resubmit → approve. The decision history shows the edit.
4. Pick a discovered signal (accept one from the Discovery inbox first) → pitch type **reactive** → the pitch responds to the actual story and reads timely.
5. Generate the **press kit** → one-liner, about paragraph, and key facts match the brain docs → edit → approve. Generate again after tweaking the `now` doc → a new version appears.
6. Export approved CSV → opens with contact columns + pitch text intact. Click **Open in email client** on an approved pitch → your mail app opens with subject and body pre-filled → send by hand.
