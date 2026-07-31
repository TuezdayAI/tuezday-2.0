# Sprint 42 — Chat / command interface, Part 2: gated action execution

> Status: spec — build in progress.
> Size: L (Part 2 of the XL sprint; Part 1 = grounded read-only copilot, already shipped).
> Spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-42-copilot-actions`, cut from **`sprint-42-chat-copilot`** (needs Part 1's copilot + chat tables).
- **Merge order into `main`:** … → S50 → S42 Part 1 (`sprint-42-chat-copilot`) → **then Part 2**.
- **Migration:** base ends at 0053 → this adds **0054** (two additive columns on `chat_messages`).

## Core principle (the whole design)

The copilot **proposes**; a **human confirms**; the write only ever creates a **gated, not-yet-executed** item. Two independent safety layers stack:

1. **In-chat confirmation** — a write tool call first returns a *proposal* (what it would do, fully rendered). Nothing is written until the user confirms with the server-issued `confirmToken`.
2. **The existing gate** — even after confirmation, the tool only calls `submitDraft` (→ `pending_review`) or the coordinator's `proposeForReview` (→ `authorization_required`). It **never** approves, authorizes, or dispatches. The human still clears the normal Review / authorize step.

This upholds the CLAUDE.md rule: *"no new business logic lives in the chat, and every state-changing action routes through the approval gate."*

### Safety finding that shaped the design

`runtime.propose(...)` **auto-authorizes and dispatches immediately** when the workspace's effective policy for that action kind is *not* `human_required`. A copilot-initiated action must never auto-send. So the coordinator gained **`proposeForReview(command, actor)`** — identical setup to `propose` (same policy/fingerprint/idempotency via `proposeWithLineage`) but always parks the action at `authorization_required`, regardless of policy. The copilot uses only this. Business logic stays in the coordinator, not the chat.

## What this slice does (founder-visible)

Ask the copilot *"Draft a LinkedIn post announcing the funnel feature"* → it composes via the normal generation path and replies **"Here's the draft — send it to Review?"** with the rendered content + a Confirm/Discard control. Confirm → it lands in **Review** exactly like any other draft. Same for *"Draft a reply to this lead"* and *"Propose sending this to the Enterprise segment"* → a **proposed** external action parked at `authorization_required`, which you then authorize through the **normal** external-action UI. You never lose a gate; the copilot just gets you there in words.

## Out of scope (later)

- The ads trio (`paid_launch` / `budget_change` / `targeting_change`) as copilot proposals — launch with `send` / `publish` / `reply`. (The coordinator already supports all six; the copilot's `propose_action` tool is scoped to the three at launch.)
- Token streaming (SSE) — single-response turns, matching Part 1.
- Any copilot path to `authorize` / `approve` / `applyDraftAction` / `runtime.run` — there is none, by design and by test.

## Founder decisions (locked 2026-07-30)

1. **Explicit Confirm/Discard button** is the authoritative commit path; a plain-text "yes" also commits *only* if it matches the pending `confirmToken` on the latest awaiting-confirmation message.
2. **Write-tool gating** reuses the existing action-layer provisioning — no new per-workspace flag.
3. **`propose_action` scope at launch:** `send` / `publish` / `reply`; ads trio deferred.
4. **Single-response** turns (no streaming), same as Part 1.

## Data model (migration 0054)

`chat_messages` gains (both nullable, additive — one `ALTER TABLE ADD COLUMN` each):
- **`proposal_json`** — the pending proposal + `confirmToken` on the assistant message that offered it.
- **`produced_ref`** — set on the committed message, e.g. `draft:<id>` / `external_action:<id>`, so the thread links to what it created.

No new table.

## Contracts (`packages/contracts`)

- `COPILOT_WRITE_TOOLS = ["draft_content","draft_reply","propose_action"]` (the write whitelist).
- `CHAT_TURN_STATUSES = ["answered","awaiting_confirmation","committed"]`.
- `chatProposalSchema` = `{ toolKind, summary, preview, confirmToken, policyNote? }`.
- `confirmChatProposalInputSchema` = `{ confirmToken, decision: "confirm"|"discard" }`.
- `chatMessageSchema` extended with `proposal?`, `producedRef?`.
- `chatTurnResultSchema` extended with `status` (default `"answered"`), `proposal?`, `producedRef?`.

## Coordinator seam (`services/external-action-coordinator.ts`)

- `proposeWithLineage(...)` gains a `forceReview` param; when true (or policy is `human_required`) it parks at `authorization_required` and never dispatches.
- `ExternalActionRuntime.proposeForReview(command, actor)` added → `proposeWithLineage(command, actor, null, true)`.

## Services

- **`services/copilot-actions.ts`** (new): the write-tool registry (`COPILOT_ACTION_TOOLS`) — the write whitelist, disjoint from the Part 1 read registry. Each tool has a **propose** half (validate args, render a preview, return `{ summary, preview, policyNote? }` — no write) and a **commit** half (perform the single gated enqueue, return `producedRef`). Tools:
  - `draft_content` → resolve context (`resolveContext`) + `llm.generate` + `storeGeneration` + `submitDraft` → `draft:<id>` in `pending_review`.
  - `draft_reply` → same, for an inbound reply context → `pending_review`.
  - `propose_action` → `runtime.proposeForReview(...)` for `send`/`publish`/`reply` → `external_action:<id>` at `authorization_required`. The propose half runs `policyFor` and surfaces a `policyNote` if it would be blocked/needs scheduling *before* the user confirms.
- **`services/copilot.ts`** (extended): a write-tool call from the model returns a proposal (persist an assistant message with `proposalJson` + a fresh `confirmToken`) and ends the turn with `status: "awaiting_confirmation"` — **no write**. New `commitCopilotProposal(db, deps, workspaceId, actor, sessionId, { confirmToken, decision })`: on `confirm`, validate the token against the latest pending assistant message, run the tool's commit half, persist an assistant message with `producedRef`, return `status: "committed"`; on `discard` (or wrong/absent token), write nothing and clear the pending proposal. The read-loop path is unchanged.
- **`services/chat.ts`** (extended): `appendMessage` carries `proposal` / `producedRef`; `rowToMessage` parses them. (Done in foundation.)

## Routes (`routes/chat.ts`)

- `POST …/chat/sessions/:sessionId/messages { message }` — unchanged entry; a turn may now return `status: "awaiting_confirmation"` with a `proposal`.
- `POST …/chat/sessions/:sessionId/confirm { confirmToken, decision }` — the authoritative commit/discard path (button). Membership-guarded, `actorOf` attribution.
- A plain-text affirmative reply is handled inside `runCopilotTurn`: if the session's latest message carries a pending proposal and the new message is an affirmative, it commits that proposal; otherwise it starts a normal turn.
- **Feature gate:** write tools are offered only when the workspace has the external-action layer provisioned (same provisioning the action routes use). Otherwise the copilot answers that actions aren't enabled here.

## Web (`apps/web`)

The copilot drawer (Part 1) gains:
- On `awaiting_confirmation`: a **proposal card** in the assistant bubble — rendered `preview`, optional `policyNote`, and **Confirm** / **Discard** buttons. Confirm POSTs to `…/confirm`.
- On `committed`: an **"Opened in Review →"** link built from `producedRef` (draft → the approval queue; external_action → the external-actions view).
Everything else (thread, citations, composer, 404-degrade) unchanged.

## Tests (`apps/api/test/copilot-actions.test.ts`)

Scripted fake LLM + fakes for the generation gateway and coordinator:
- `draft_content` proposal → **no draft exists yet** (write deferred to confirm); after confirm → exactly one draft in `pending_review`, `producedRef` = `draft:<id>`.
- `draft_reply` → same shape for a reply context.
- `propose_action` → after confirm, exactly one external action at `authorization_required` (never `authorized`/`dispatching`), even when the effective policy is autonomous (`proposeForReview` path); a policy-blocked case surfaces the `policyNote` in the proposal.
- **Guardrails (critical):**
  - No write tool can reach `authorize` / `approve` / `applyDraftAction("approve")` / `runtime.run` — asserted by construction (the registry exposes only propose/commit halves) and behaviourally (no action ever leaves `authorization_required` / `pending_review` via the copilot).
  - A confirm with a wrong/absent/stale `confirmToken` writes nothing.
  - An un-confirmed proposal writes nothing (the propose turn is side-effect-free apart from persisting the chat messages).
  - Part 1's read-only no-mutation guardrail still holds with write tools registered.
- REGRESSION: full suite green; typecheck clean.

## Founder acceptance checklist

1. "Draft a post about X" → preview + Confirm; confirm → appears in Review as a normal draft; reload persists the thread + the "Opened in Review" link.
2. "Propose sending this note to the Enterprise segment" → proposed action; authorize it through the **normal** external-action UI (not the chat) and confirm it dispatches there.
3. A policy-blocked action shows the block note *before* you confirm.
4. Decline a proposal → nothing is created.
5. Confirm nothing bypasses Review/authorize — the copilot never sends/publishes directly (even under an autonomous policy).

## Progress log

- 2026-07-30 — Spec written after recon of the draft/approval gate (`submitDraft` → `pending_review`), the external-action coordinator (`propose` auto-dispatches under autonomous policy — hence the new `proposeForReview` seam), and the generation pipeline (`resolveContext` + `generate` + `storeGeneration`). Four decisions locked. Foundation landed: contracts (write whitelist, turn status, proposal + confirm schemas, extended message/turn-result), `chat_messages.proposal_json`/`produced_ref` + migration 0054, `chat.ts` persistence plumbing, coordinator `proposeForReview`. Typecheck clean; 99 copilot/external-action tests green.
- 2026-07-30 — Part 2 complete. API: `services/copilot-actions.ts` (write registry — `draft_content`/`draft_reply` → `pending_review` drafts, `propose_action` → `authorization_required` external action via `proposeForReview`; each tool a propose + commit half), `services/copilot.ts` two-phase turn (`runCopilotTurn` returns a proposal + `confirmToken` and ends `awaiting_confirmation` with no write; `commitCopilotProposal` runs the commit half on a matching token; plain-text "yes" also confirms), `getPendingProposal` (latest assistant proposal; a trailing user "yes" doesn't retire it), `POST …/confirm` route + `runtime` threaded through `registerChatRoutes`/`app.ts`. Web: proposal card (preview + policy note + Confirm/Discard, retired once resolved) and an "Open in Review" link (drafts + actions both land on the Review page). Tests: 9 new (propose-without-write, confirm → gated item, `authorization_required` even under autonomous policy, policy note, plain-text yes, wrong-token/discard write nothing, read-only turn never writes, registries disjoint). Full suite green (1616); typecheck clean; lockfile clean. Awaiting founder acceptance + merge.
  - Build note: the two parallel build agents both died on transient 529 overloads, so the API + web layers were implemented directly instead.
  - Deviation: `propose_action` creates a governed action skeleton (subject id minted) for the send/publish/reply kinds; wiring a real approved-draft subject and the ads trio is a follow-up.
