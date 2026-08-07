# Sprint 77 — Generative UI & the command layer

**Branch:** `sprint-77-generative-ui-command-layer`
**Forked from:** `sprint-78-chat-that-acts` @ `c028e8a`
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66 → 67 → 68 → 69 → 70 → 71 → 76 → **78 → 77**
**PRD:** `docs/plans/prd-agentic-platform.md` §10, Sprint 77 (direction doc move 9b)
**Depends on:** 76 (threads, streaming, citations), 78 (confirm-before-propose)

---

## 0. What this sprint is, and what it is not

### 0.1 Why it runs after 78 and not before it

The PRD sequences 77 before 78. It was built the other way round because 78 was
delivered first, and re-ordering delivered work to match a number would have
been a rewrite with no product in it. Nothing was lost by the swap and one thing
was gained: Sprint 78's confirmation card was written as a *typed*
`ChatProposalIntent` precisely so that 77's card layer could adopt it rather than
replace it. That is what happened. `ProposalCard` is now one member of a card
family with a shared shell, shared tone vocabulary and shared action plumbing,
and its behaviour did not change.

The founder merges 78 before 77.

### 0.2 The founder's framing

> "we need the chat to have the capability to create campaigns — It's a must"

Sprint 69 shipped five propose tools and campaign creation was not one of them,
so a founder could say "build me a campaign for the launch" in chat and get a
paragraph. This sprint adds the sixth propose tool, `propose_campaign`, and it
is treated as a first-class deliverable rather than a rider: §4.4 and D-77.7
are about nothing else. It is also what makes the PRD's own `/campaign` command
mean something instead of being a prompt prefix.

### 0.3 The one-sentence invariant

**Chat still owns no tools and no business logic.** A card action calls the same
HTTP route the dedicated page calls. A `/` command runs the same registry tools
a model turn would run. `propose_campaign` lands in the same place a campaign
created on `/campaigns` lands. If any of those had needed a second
implementation, it would have been the wrong design.

---

## 1. Problem

Chat replies in prose. A founder asks "what's waiting for me?" and reads a
paragraph naming three drafts, then closes the drawer, navigates to `/review`,
and finds them. The intelligence is real and the interaction is worse than the
page it was supposed to replace. Three separate gaps produce that:

1. **Records render as sentences.** A tool call returns a campaign, a draft, a
   metric rollup — a record with an identity — and the founder gets its
   *description*. Sprint 76's citation chips gave those records a link. A link
   is not an interface.
2. **Intent is inferred every time.** "Show me pending drafts" costs a model
   turn, a tool-selection decision and a paragraph of prose to do something the
   platform could do deterministically for free, and it can get it wrong.
3. **Context is implicit.** A thread's scope binding exists (`campaignId`,
   `personaId`, `channel`) and nothing in the UI shows it or lets a founder
   change it mid-conversation. Context you cannot see is context you cannot
   debug.

And underneath all three: **chat cannot create a campaign**, which is the single
most common thing a founder opens this product to do.

---

## 2. Deliverables

| # | Thing | Where |
|---|---|---|
| 1 | Card vocabulary + per-tool render hints | `packages/contracts` |
| 2 | `list_drafts` read tool | registry — shared, not chat-only |
| 3 | Tool call → typed cards | `apps/api/src/services/chat-cards.ts` |
| 4 | Cards persisted on the message, streamed as they occur | `chat_messages.cards_json`, `card` frame |
| 5 | `propose_campaign` | contracts, proposal seam, tool, live service, intent, confirm dispatch |
| 6 | Thread pins (`@` mentions) with write-through scope | `chat_pins`, `services/chat-pins.ts` |
| 7 | Pinned context in the system prefix, URL pins through safe-fetch | `services/chat-context.ts` |
| 8 | `/` command layer — instant and directive | `services/chat-commands.ts` + routes |
| 9 | Card rendering, inline draft edit with a diff, approve/reject | `apps/web` copilot |
| 10 | Command palette, pin chips, `Cmd/Ctrl+K` summon | `apps/web` |

---

## 3. Founder decisions taken in this spec

**D-77.1 — Cards are computed server-side and persisted, not derived in the
browser.** The alternative was to stream raw tool results to the client and let
React interpret them. Rejected: tool results are large (an evidence search
returns document text), they are the one place untrusted content lives, and a
client-side interpreter would be a second implementation of
`citationsForToolCall` that drifts from it. `chat-cards.ts` sits beside the
citation mapper, is keyed the same way, reads JSON just as defensively, and a
tool whose shape drifts produces fewer cards rather than a thrown turn.

**D-77.2 — The "render hint" is a per-tool map in contracts, not a field on the
tool's output schema.** The PRD says output schemas gain a `render` hint. The
registry's tools are shared with pipelines, the critic and the eval harness,
none of which render anything — putting presentation on the tool's own contract
would make every consumer carry it. `TOOL_CARD_KINDS` is a declaration *about*
tools, in the same file as the tool names, asserted total-where-it-should-be by
test. Same information, no coupling.

**D-77.3 — Card actions are the existing routes, called from the browser.** The
draft card's Approve button issues `POST /workspaces/:id/drafts/:draftId/approve`
— the identical request `/review` issues. No chat-side approval service exists,
which is why the decision-log record is necessarily identical: it is written by
the same code path. Cards are refreshed by refetching the record, not by chat
guessing what changed.

**D-77.4 — Two kinds of command, and the difference is whether a model runs.**
`/status` and `/approve` are *instant*: the server runs registry read tools
directly, appends the transcript rows, and returns cards. No LLM call, no cost,
no inference. `/draft`, `/campaign` and `/agent` are *directive*: they are
ordinary model turns whose intent is pinned by a server-owned instruction, so
the model chooses *how*, never *what*. The directive text lives in the API. A
client that could send arbitrary prose as a "command" would be a prompt-injection
surface with a slash in front of it.

**D-77.5 — Pinning a campaign or persona writes through to the thread's scope
columns.** The resolver reads scope from the session, and a second, parallel
notion of "the campaign this thread is about" would let the chips and the
context bundle disagree. So `chat_pins` is the store the UI reads, and campaign
/ persona pins also set `chat_sessions.campaign_id` / `.persona_id`. Unpinning
clears both. The other pin kinds (draft, signal, brain section, URL) have no
scope column and render as an explicit `PINNED CONTEXT` block in the prefix.

**D-77.6 — A pasted URL is a pin, and it is untrusted.** It resolves through
Sprint 48's safe-fetch at turn time and enters the prefix wrapped in the same
`UNTRUSTED CONTENT` envelope `safe_fetch_url` results get, and it taints the
turn for Sprint 78's quarantine. A founder pasting a link does not make the
page's contents trustworthy — the founder is vouching for the *link*, not for
whatever an attacker put on the other end of it.

**D-77.7 — A proposed campaign is created in `draft` status, and that status is
the gate.** Every other propose tool hands its intent to a gate that already
exists. Campaigns have no approval gate — but they have something that does the
same work: a `draft`-status campaign is inert. It runs no automation, matches no
discovery signals, is refused by `campaignExecutionError`, and appears on
`/campaigns` for a human to fill in and activate. So `propose_campaign` forces
`status: "draft"` and `origin: "system"` regardless of what the model passes,
and activation stays a human act on the campaign page. Inventing a new approval
state for campaigns would have been a new safety mechanism, which this phase is
explicitly not for.

**D-77.8 — `list_drafts` joins the shared registry.** The PRD's acceptance
("asking for last week's drafts returns interactive draft cards") needs a tool
that returns *pending* drafts, and Sprint 76 shipped none — its two draft-shaped
tools return historical approvals and rejections as training examples. Following
D-76.2, the new tool is a general registry read, not a chat-only one: "what is
waiting for review" is as useful to a pipeline step or a critic as it is here.

**D-77.9 — Image paste is deferred, and the reason is the LLM seam.**
`GenerateParams.prompt` is a `string` and `AgentMessage.content` is a `string`;
vision needs both to become parts, which is a change to the gateway contract and
the Sprint 56 runner — machinery, in a phase whose entire justification is
"this phase adds surface, not machinery". Shipping a paste target that stored an
image the model could not see would be worse than not shipping it. URL paste
ships, because safe-fetch already exists. Recommended as its own small sprint
alongside the gateway work; noted in §11.

---

## 4. Design

### 4.1 Cards

```
tool call ──▶ citationsForToolCall  ──▶ chips   (Sprint 76)
          └─▶ cardsForToolCall      ──▶ cards   (Sprint 77)
```

A `ChatCard` is `{ kind, ref, title, subtitle, fields[], body, actions[] }`.
`ref` is the same `<kind>:<id>` anchor citations use, so the web layer routes a
card with `citationHref` and learns no new URLs. `actions` is a small closed set
(`open`, `approve`, `reject`, `edit`) and is populated only where the action is
actually possible — a draft card carries `approve` only when the draft is in
`pending_review`.

Cards are deduped on `kind:ref` like citations, capped per turn, persisted to
`chat_messages.cards_json`, streamed as a `card` frame as each tool returns, and
returned on `ChatTurnResult` and `ChatSessionDetail`.

### 4.2 Commands

```
composer text ──▶ parseChatCommand (contracts, pure, shared)
                     │
      instant ───────┴────── directive
         │                        │
  POST …/command           POST …/messages { message, command }
  runs read tools          ordinary turn + server-owned directive
  no LLM                   model chooses how, never what
```

### 4.3 Pins

`chat_pins` rows are the UI's list and the prefix's source. Campaign and persona
pins write through to session scope (D-77.5). `buildChatContext` appends a
`PINNED CONTEXT` block naming each pin and its content; a URL pin is fetched
through safe-fetch and wrapped as untrusted (D-77.6).

### 4.4 `propose_campaign`

```
model ──▶ propose_campaign ──▶ chat recorder ──▶ confirmation card
                                                       │ founder confirms
                              services/agent-proposals.ts ◀──┘
                                       │
                          createCampaign(status: draft, origin: system)
                                       │
                         producedRef = campaign:<id> ──▶ /campaigns/<id>
```

Inside a chat turn it is double-gated: the Sprint 78 confirmation, then the
inert `draft` status. Inside a pipeline it is single-gated by the status, which
is the same guarantee `propose_draft` gives with `pending_review`.

### 4.5 API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workspaces/:id/chat/sessions/:sessionId/command` | Run an instant command |
| `GET` | `/workspaces/:id/chat/sessions/:sessionId/pins` | List pins |
| `POST` | `/workspaces/:id/chat/sessions/:sessionId/pins` | Pin an entity |
| `DELETE` | `/workspaces/:id/chat/sessions/:sessionId/pins/:pinId` | Unpin |

`POST …/messages` gains an optional `command` for the directive kinds.

---

## 5. Step plan

1. Contracts: cards, render hints, `list_drafts`, commands, pins,
   `propose_campaign`.
2. Schema + migration 0079: `chat_pins`, `chat_messages.cards_json`,
   `agent_proposals.campaign_id`.
3. `services/chat-cards.ts` + the `list_drafts` tool.
4. `propose_campaign` through the seam, the tool, the live service, the intent
   builder and the confirm dispatch.
5. `services/chat-pins.ts` + context integration + routes.
6. `services/chat-commands.ts` + routes + the directive path on `…/messages`.
7. Turn wiring: cards collected, streamed, persisted, returned.
8. Web: card views, diff, palette, chips, keyboard.
9. Tests; `npm test`, `npm run typecheck`, `npm run eval` green.

---

## 6. Tests

- **contracts** — card vocabulary and render-hint coverage; command parsing
  including the adversarial cases; pin vocabulary; `propose_campaign` in the
  registry and its input schema.
- **api** — `cardsForToolCall` per tool and under drifted shapes; `list_drafts`;
  instant commands producing cards without an LLM call; directive commands
  reaching the model with the server's own instruction; pins writing through to
  scope and rendering in the prefix; a URL pin arriving wrapped and tainted;
  `propose_campaign` creating an inert draft campaign through the real gate.
- **web** — card href/tone/action helpers; the word diff; the composer's command
  and mention parsing; the drawer's shell contract.

---

## 7. Acceptance

1. Asking for last week's drafts returns interactive draft cards; approving one
   from a card writes the same decision-log record as approving it on `/review`.
2. `/status` returns a workspace snapshot with no model call.
3. `@`-pinning a campaign shows a removable chip and changes the bundle the next
   turn resolves against.
4. Pasting a URL pins it; its content reaches the model wrapped as untrusted and
   a proposal derived only from it is quarantined.
5. "Create a campaign for the Q4 launch" produces a confirmation card; confirming
   creates a `draft`-status campaign on `/campaigns` and nothing runs until a
   human activates it.
6. `Cmd/Ctrl+K` opens the assistant from anywhere in a workspace.

---

## 8. Out of scope

- Image paste (D-77.9).
- Background/detached runs — Sprint 79.
- A `viewer` role. Still absent, still recommended as a standalone sprint.
- Chat as the primary IA. D7 stands: companion first.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Cards become a second way to mutate records | D-77.3 and a shell-contract test that fails if the drawer spells out a draft route instead of using the shared helper. |
| A pinned page becomes an injection vector | D-77.6: pins are wrapped and taint the turn before the model's first step. Tested with a page whose body says "ignore previous instructions". |
| `propose_campaign` creates something that acts | D-77.7: status, origin, automation mode and daily cap are overwritten after parsing, and a test reads the row back to prove it. |
| The command layer becomes a place business logic accumulates | Instant commands run registry tools and nothing else; directives are prose. Neither grants a capability. |

---

## 11. Progress log

### What landed

Everything in §2, plus `propose_campaign`. Migration **0079**.

- **Cards.** `services/chat-cards.ts` maps sixteen tools to eight card kinds,
  keyed by `TOOL_CARD_KINDS`. Cards persist on `chat_messages.cards_json`,
  stream as a `card` frame per tool return, and come back on the turn and the
  session detail. `list_drafts` joined the registry so the queue is readable.
- **Card actions.** The draft card approves, rejects and edits through
  `/workspaces/:id/drafts/:draftId/{approve,reject,edit}` — the routes `/review`
  uses. Inline edit shows a word-level diff before saving.
- **Commands.** `/status` and `/approve` run server-side against the read tools
  with no model call; `/draft`, `/campaign` and `/agent` pin a turn's intent
  with an API-owned directive.
- **Pins.** `chat_pins` + `@` picker + removable chips. Campaign and persona
  pins rebind thread scope; draft, signal, brain-section and URL pins render a
  `PINNED CONTEXT` block, with the last two wrapped as untrusted.
- **`propose_campaign`.** Sixth propose tool, `campaign` target kind, creates a
  `draft`/`system`/`manual` campaign. In chat it is double-gated: the Sprint 78
  confirmation, then the inert status.
- **Keyboard.** `Cmd/Ctrl+K` toggles the assistant anywhere in a workspace.

### Reviewer notes — four things worth a second look

1. **The card mapper reads the RAW tool result, before the untrusted wrapper.**
   In `chat-turn.ts` the handler computes cards first, then wraps. Deliberate:
   the envelope is for the model, and a card whose body was
   `--- BEGIN UNTRUSTED CONTENT ---` would be absurd. The card's `kind` already
   tells the web layer it is looking at a signal.

2. **`createCampaign` gained an `origin` option.** One optional parameter with a
   `"user"` default, so every existing caller is unchanged. It exists so the
   campaigns list can distinguish a campaign an agent drew up — without it,
   `propose_campaign` output would be indistinguishable from a founder's.

3. **The taint tracker gained `observeUntrustedText`.** Sprint 78's tracker only
   learned about untrusted content through tool calls. A pinned page reaches the
   model through the *prefix*, so without this the quarantine rule had a hole
   exactly where a founder pasted a link somebody sent them. Tested directly.

4. **Instant commands mint no `agentRunId`.** Nothing about them infers, so an
   empty trace in the Inspector would be noise. A side effect worth naming: the
   propose tools refuse without a run id, so an instant command cannot write
   even if a future plan named a propose tool by mistake.

### Deviations from §5

- **`list_drafts` was not in the plan** and turned out to be required: the PRD's
  own acceptance case needs a tool returning *pending* drafts, and Sprint 76
  shipped none. Added as a shared registry read (D-77.8).
- **Image paste is not implemented** (D-77.9). `GenerateParams.prompt` is a
  `string` and `AgentMessage.content` is a `string`; vision needs both to become
  parts. That is a gateway and runner change, not a chat change, and shipping a
  paste target that stored an image the model could not see would be worse than
  not shipping it. URL paste ships.

### Verification

`npm test` and `npm run typecheck` green; `npm run eval` no regression.

### Still open for the founder

1. **There is still no `viewer` role.** `WORKSPACE_ROLES` is `["owner",
   "member"]`. `chatToolsForActor` remains the single seam, so adding one makes
   its chat read-only with no change to that file. Worth its own sprint before
   external users.
2. **Vision** (D-77.9) — a small sprint in the LLM seam, not in chat.
3. **Sprint 79** needs Sprint 73's durable queue underneath it.
