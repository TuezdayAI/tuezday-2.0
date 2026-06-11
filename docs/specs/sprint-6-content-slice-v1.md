# Spec: Sprint 6 — Content Slice v1

> Status: in build
> Covers Phase 5 of the rebuild plan, milestone M5. The first real module, with the fewest moving parts: manual signal input, not scraping.

## What this slice does

The founder pastes a market signal (a Reddit thread, an X/LinkedIn post, a customer quote, an idea). Tuezday drafts a response through the full brain pipeline — org docs + channel + persona + **the signal itself** — and the draft lands in the Sprint 5 approval queue. After approval, the founder copies or downloads the content. The signal list shows where every signal stands.

## Out of scope

Scraping/RSS/source adapters (Sprint 9), posting to platforms (export/copy only — no credentials flow), campaigns (Sprint 7), relevance scoring, signal triage workflows.

## Behavior

### Vocabulary (contracts)

- New signal sources: `reddit`, `x`, `linkedin`, `other` (where the signal came from — distinct from the response channel).
- New task type: `signal_response` (joins the four sandbox task types; its instruction directs the model to respond to the signal section).

### Data

- `signals`: id, workspaceId, content (1–10,000 chars), source, sourceUrl (nullable), createdAt.
- `drafts` gains nullable `sourceSignalId` — a content item is a draft linked to a signal, flowing through the existing approval gate unchanged.

### Resolver (`packages/brain`)

`resolveContext` accepts an optional `signal` — when present, a new `signal` layer section (title "Market signal", content = signal text + source attribution) is inserted **after persona, before task**, so the task instruction can say "respond to the signal above". Absent → section appears excluded with reason, like the campaign slot.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/signals` | body `{content, source, sourceUrl?}` → `201` signal. |
| `GET /workspaces/:id/signals` | newest first, each with its drafts' `{id, state, channel}` summaries. |
| `POST /workspaces/:id/signals/:signalId/draft` | body `{channel, personaId?, tokenBudget?}` → resolves context **with the signal**, generates via the LLM gateway, stores the generation (training log), creates a draft (`sourceSignalId` + `sourceGenerationId` set) directly in `pending_review`. Returns `201` draft. `502` on provider failure (nothing stored). A signal can have multiple drafts (e.g. different channels). |

### Web (`/workspaces/[id]/content`)

1. Paste-a-signal form: textarea + source select + optional URL.
2. Signal inbox: each signal shows its text, source (linked if URL), and linked drafts with state badges; "Draft response" opens channel + persona pickers and generates.
3. Drafts link into the approval queue.
4. **Copy** and **Download .md** buttons on approved drafts (here and on the approvals page).
5. Nav links from the other workspace pages.

## Automated verification

- Brain: signal section presence/absence, ordering (after persona, before task), attribution in content, prompt assembly.
- Contracts: signal schemas, `signal_response` in task types.
- API: signal create/validate/list; draft-from-signal happy path (fake gateway) — draft in `pending_review` with both source ids, generation stored; provider-failure path; signal list includes draft summaries; 404s.

## Founder acceptance checklist (M5 gate)

1. Paste a real Reddit/X/LinkedIn signal you'd actually want to respond to.
2. Draft a response as CEO for LinkedIn — the draft reads like *your* take on *that* signal.
3. Edit/approve it in the queue.
4. Copy/download the approved content and (manually) post it wherever you like.
5. The signal inbox shows the signal → draft → approved chain at a glance.

This is the first end-to-end loop: **signal → brain → draft → human approval → shippable content.**
