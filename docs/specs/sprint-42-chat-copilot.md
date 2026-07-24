# Sprint 42 — Chat / command interface, Part 1: grounded copilot

> Status: spec — build in progress.
> Size: L (Part 1 of the XL sprint; Part 2 = gated action execution, a separate sprint).
> Spec-first; tests before/with implementation; founder accepts + merges.

## Branch & merge order

- **Branch:** `sprint-42-chat-copilot`, cut from **`sprint-50-outreach-tracking`** so the copilot's outreach-funnel read tool has its dependency present.
- **Merge order into `main`:** … → S50 → **then S42**. (Part 1 only; Part 2 follows.)
- **Migration:** base ends at 0052, so this adds **0053**.

## Why this sprint (context for a fresh session)

The deliberately-last roadmap item (U12): a copilot that answers from the brain + evidence + live campaign/outreach data — and, in Part 2, executes gated actions. **Chat is a presentation/orchestration layer over existing services; no new business logic lives in the chat, and (Part 2) every state-changing action routes through the approval gate.** Part 1 is the grounded, **read-only** Q&A copilot.

## Founder decisions (locked 2026-07-23)

1. **JSON tool-loop over the existing `generate`** (no gateway change) — the model emits `{"tool","args"}` JSON; the service runs the whitelisted read tool and feeds the result back, mirroring the discovery-scoring pattern.
2. **Single-response** turns (run the loop server-side, return the finished answer + citations). Streaming is a later upgrade — none exists in the repo today.
3. **Global slide-over panel** — a copilot drawer reachable from the workspace nav on any page.
4. **Full read set** of tools.

## What this slice does (founder-visible)

Open the copilot drawer anywhere → ask "What's working in the Launch campaign?", "Summarize our ICP", "Which sequence has the best reply rate?" → get an answer **grounded** in the brain, evidence, and live data, with **citations** you can inspect. Conversations persist per workspace+user. **Nothing changes state** — it's read-only.

## Out of scope (Part 2 / later)

- Action execution (draft a post, launch a sequence) → **Part 2**: write tools reuse the S40 `/api/v1` action layer and `submitDraft`, and every write lands in `pending_review` via the approval gate.
- Token streaming (SSE) — request/response JSON in Part 1.
- No gateway/function-calling change; no new LLM provider surface.

## Architecture decisions (grounded in recon)

1. **Prompt-engineered tool-loop, not native function-calling.** `LlmGateway.generate({prompt}) → text` is prompt-string only. `services/copilot.ts` serializes the system preamble + tool catalog + conversation transcript + prior tool results into one prompt, calls `generate`, and parses the reply as either a final answer or a `{"tool","args"}` JSON object (new `parseJsonObject`, sibling to `matching.ts` `parseJsonArray`). Runs the tool, appends its result to the transcript, re-generates. **Bounded** by a max-iteration cap; each `generate` wrapped in try/catch to degrade to a plain answer on `GatewayError` (the `scoreUnscoredItems` discipline).
2. **Structurally read-only.** The tool registry contains only read wrappers over pure-read services — there is no write tool to call, so the copilot cannot mutate. A test asserts the registry is the whitelist and no write service is reachable.
3. **Citations from the tools.** `search_brain` returns `{docType, sectionId (slug), heading}` (via `parseDocSections`); `search_evidence` returns `{title, documentId, score}` (via `retrieveEvidence`, which never throws and is workspace-scoped). The service collects these into the assistant message's `citations` for the UI to render.
4. **Workspace + user scoped, auth for free.** Routes mount under `/workspaces/:id/chat/…` → the guard enforces membership; `actorOf(request)` attributes the session/messages to the user.
5. **Reuse existing services verbatim** — every tool is a thin wrapper; no aggregation logic is reinvented (`get_workspace_summary` composes `getWorkspaceInsights` + `getNextActionView` + `listWorkspacePriorities`).

## Data model (migration 0053)

- **`chat_sessions`** (new): `id` PK · `workspace_id` NN→workspaces cascade · `user_id`→users set null · `title` NN default `''` · `created_at`/`updated_at`. Index `(workspace_id, user_id)`.
- **`chat_messages`** (new): `id` PK · `session_id` NN→chat_sessions cascade · `workspace_id` NN · `role` NN (`user`/`assistant`/`tool`) · `content` NN · `tool_name` · `citations_json` NN default `'[]'` · `created_at`. Index `(session_id, created_at)`.

## Contracts (`packages/contracts`)

`CHAT_MESSAGE_ROLES = ["user","assistant","tool"]`. `chatCitationSchema` (`{ kind: "brain"|"evidence"|"data", ref, label, detail? }`). `chatSessionSchema`, `chatMessageSchema` (role, content, toolName?, citations[]). `createChatSessionInputSchema` ({ title? }). `sendChatMessageInputSchema` ({ message: 1..4000 }). `chatTurnResultSchema` ({ answer, citations[], toolCalls: [{ tool, ok }] }). `chatSessionDetailSchema` (session + messages[]).

## Services

- **`services/copilot-tools.ts`** (new): the read-tool registry. Each tool = `{ name, description, argsSchema (zod), run(ctx, args) → { summary: string, citations?: ChatCitation[] } }`. Tools (full set): `search_brain`, `search_evidence`, `list_campaigns`, `get_campaign_insights`, `get_workspace_insights`, `list_outreach_sequences`, `get_sequence_funnel`, `list_audiences`, `list_leads`, `get_workspace_summary`. All pure reads, workspace-scoped. This registry is the whitelist.
- **`services/copilot.ts`** (new): `runCopilotTurn(db, { llm, evidence }, workspaceId, actor, sessionId, userMessage) → ChatTurnResult`. Loads history, builds the prompt (system preamble + tool catalog + transcript), runs the bounded tool-loop, persists the user + assistant (+ tool) messages, returns the answer + citations. Max ~6 iterations; degrade to a best-effort answer on parse/gateway failure.
- **`services/chat.ts`** (new): session/message persistence CRUD (create/list/get sessions, append messages) — thin DB layer the routes + copilot share.
- Reused (unchanged): `getBrain`, `parseDocSections`, `retrieveEvidence`, and the read services above.

## Routes (`routes/chat.ts`, `registerChatRoutes(app, db, llm, evidence)`)

`POST /workspaces/:id/chat/sessions` (create) · `GET …/chat/sessions` (list) · `GET …/chat/sessions/:sessionId` (session + messages) · `POST …/chat/sessions/:sessionId/messages { message }` (run a turn → answer + citations) · `DELETE …/chat/sessions/:sessionId`. Register after the auth guard, alongside `registerSignalRoutes(app, db, llm, evidence)`.

## Web (`apps/web`)

A **global copilot slide-over** launched from the workspace nav (available on any page): a session list, a message thread (user/assistant bubbles), **citation chips** under assistant answers (brain § / evidence source / data), and a composer. Degrade gracefully if the chat routes 404. Reuse existing components/tokens.

## Tests (`apps/api/test/copilot.test.ts`)

With a **scripted fake LLM** (a queued sequence of `generate` replies): the loop routes a `{"tool":"…"}` reply to the right read tool, feeds the result back, and produces a grounded final answer; citations reference real brain sections / evidence chunks; the loop terminates at the iteration cap; a tool-arg validation failure and a mid-loop `GatewayError` both degrade to an answer (never throw); session + message persistence; workspace scoping (no cross-workspace data); **the guardrail — every registered tool is read-only, no write service reachable**. REGRESSION: full suite green; typecheck clean.

## Founder acceptance checklist

1. Open the copilot on the dashboard; ask "Summarize our ICP" → a grounded answer citing the `icp` brain sections.
2. Ask "Which outreach sequence has the best reply rate?" → it calls the funnel tool and answers with numbers + a citation.
3. Ask "What should I focus on?" → it uses the workspace summary (next-action + priorities).
4. Confirm citations are inspectable and the conversation persists across a reload.
5. Confirm it never changes anything (read-only) — e.g. "launch a campaign" returns an explanation that actions arrive in Part 2, not an execution.

## Progress log

- 2026-07-23 — Spec written from the approved draft plan after a 2-agent recon (gateway/tool-loop + grounding/retrieval; read-tool data sources + S40 action layer). Four decisions locked (all recommended). Implementation started.
