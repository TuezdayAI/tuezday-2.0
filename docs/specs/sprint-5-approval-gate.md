# Spec: Sprint 5 — Approval Gate

> Status: in build
> Covers Phase 4 of the rebuild plan, milestone M4. The approval gate is the trust layer every module (Content, Outbound, Ads, PR) will route generated work through.

## What this slice does

A sandbox generation can be sent into an approval queue as a **draft**. The founder can edit it, approve it, or reject it. Every action is recorded in a decision log (what happened, from which state to which state, when, with what content). The state machine is enforced server-side — invalid transitions are refused, never silently absorbed.

## Out of scope

Posting/exporting approved content (Sprint 6), multi-user roles/auth (single founder actor for now), approval of anything other than sandbox generations (later slices plug their own sources into the same gate), notifications.

## Behavior

### State machine (locked vocabulary from `packages/contracts`)

States: `draft`, `pending_review`, `edited`, `approved`, `rejected`.
Actions and allowed transitions:

| Action | From → To |
|---|---|
| `submit` | `draft` → `pending_review` |
| `edit` | `pending_review` → `edited`, `edited` → `edited` (re-edit) |
| `resubmit` | `edited` → `pending_review` |
| `approve` | `pending_review` → `approved`, `edited` → `approved` |
| `reject` | `pending_review` → `rejected`, `edited` → `rejected` |

`approved` and `rejected` are terminal. Approving from `edited` is the "edit-before-approve" flow; the decision log preserves that the approval came from an edited state (the plan's state diagram routes Edited → PendingReview → Approved; we additionally allow approving directly from `edited` so edit-and-approve is one founder action, with the prior state recorded — same audit trail, one less click). The transition table is a pure function in contracts (`canTransition`), shared by API and UI.

### Data

- `drafts`: id, workspaceId, sourceGenerationId (nullable — future slices submit from other sources), taskType, channel, personaId (nullable), originalContent (as generated, immutable), content (current), state, createdAt, updatedAt.
- `approval_decisions` (append-only): id, draftId, workspaceId, action, fromState, toState, contentSnapshot (nullable — set on `edit`), actor (constant `founder` until auth exists), createdAt.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/generations/:generationId/submit` | Creates a draft from the generation (content = generation output) directly in `pending_review`, logs `submit`. `409 already_submitted` if that generation already has a draft. `404` unknown generation. |
| `GET /workspaces/:id/drafts?state=` | Queue list, newest first; optional state filter. |
| `GET /workspaces/:id/drafts/:draftId` | Draft + its full decision log (oldest first). |
| `POST /workspaces/:id/drafts/:draftId/edit` | body `{content}` (1–50,000 chars) → state `edited`, content updated, decision logged with snapshot. |
| `POST /workspaces/:id/drafts/:draftId/resubmit` | `edited` → `pending_review`. |
| `POST /workspaces/:id/drafts/:draftId/approve` | → `approved`. |
| `POST /workspaces/:id/drafts/:draftId/reject` | → `rejected`. |

All transition endpoints return the updated draft; an illegal transition returns `409 invalid_transition` with a message naming the current state and attempted action. `404`s as usual.

### Web

- Sandbox: every generation (latest output and log entries) gets a **"Send to approval queue"** button; already-submitted ones show a link to the draft instead.
- `/workspaces/[id]/approvals`: state filter tabs with counts, draft cards (content, task/persona/source meta), inline edit (textarea → save = `edit`), Approve / Reject / Resubmit per state, expandable decision history per draft, diff-style display of original vs current content when edited.
- Nav links from brain/sandbox/resolver headers.

## Automated verification

- Contracts: `canTransition` truth table — every allowed pair, and representative forbidden pairs.
- API: submit happy path + duplicate guard; edit/resubmit/approve/reject happy paths; edit-then-approve preserves edited content and logs both; terminal-state immutability (`edit` after approve → 409, `approve` after reject → 409); queue filtering; decision log order and content snapshots; 404s.

## Founder acceptance checklist (M4 gate)

1. Generate in the sandbox → send to approval queue.
2. In the queue: edit the draft, see state `edited`, approve it — final content is your edited version.
3. Reject a second draft.
4. Open both decision histories — every step is there with timestamps and prior states.
5. Try to edit an approved draft — the API refuses, the UI doesn't offer it.
