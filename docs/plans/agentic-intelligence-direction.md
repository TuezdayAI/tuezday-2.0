# Making Tuezday Intelligent: An Agentic Architecture Direction

> **Status:** Proposal for founder decision — not yet scheduled as sprints
> **Date:** 2026-07-26
> **Companion docs:** `docs/whats-actually-built.md` (code-verified inventory), `docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md` (pipeline/lane control plane), `docs/plans/sprint-guide-21-onward.md`
> **One-line thesis:** Tuezday has built a world-class agent harness and put no agent in it.

---

## 1. The Diagnosis

### 1.1 The structural fact

This is the platform's entire AI interface (`apps/api/src/llm/gateway.ts`):

```ts
export interface GenerateParams { prompt: string; maxOutputTokens?: number }
export interface GenerateResult { text: string; model: string; provider: string; durationMs: number }
export interface LlmGateway { generate(params: GenerateParams): Promise<GenerateResult> }
```

Single-shot. String in, string out. No tool definitions, no message array, no structured output, no loop, no streaming, no usage accounting.

Every "AI feature" in Tuezday is therefore the same shape:

```
deterministic TypeScript assembles a prompt
  → one model call
  → deterministic TypeScript parses text back into structs
```

`matching.ts` (402 lines), `review.ts` (173), `signal-drafting.ts` (137), `ad-creatives.ts`, `angles.ts`, `brain-autodraft.ts`, `carousels.ts` — all the same. The 16 task types have their instructions hard-coded in `packages/brain/src/resolver.ts:182` (`TASK_INSTRUCTIONS`). The model is a text-completion function called from the middle of a flowchart.

### 1.2 The four capabilities that are missing

Everything the founder perceives as "not intelligent enough" reduces to four absences:

**1. The model cannot retrieve.** If generating a LinkedIn post would benefit from knowing that the last three posts on this topic underperformed, or that the campaign plan lists "developer velocity" as a pillar, or what the competitor announced yesterday — either a service pre-fetched it into the resolver bundle, or it does not exist for that call. The model cannot go and get it. This is why the output feels generic: it is generic, because it is written from a fixed context packet rather than from investigation.

**2. The model cannot decide.** `automation.ts` decides: fresh signal → best-scoring campaign → cadence channel → task type → draft → gate. That decision tree is TypeScript. The model is never asked "what is the right response to this signal?" — only "write the thing I already decided on." A signal that deserves a five-post thread, or deserves nothing, or deserves a note to the founder rather than a post, gets a post.

**3. The model cannot verify.** `review.ts` is a second single-shot scorer that reads the same text with no additional evidence. It cannot pull the voice doc's examples, cannot compare against the last ten approved posts, cannot check the guardrail list, cannot open the URL the draft cites. It produces a number, not a finding.

**4. The model cannot ask.** In the entire codebase there is no path by which the system says "I need a decision from you before I proceed." It either succeeds silently or fails into a queue. Every mature ambient-agent product treats *asking* as a first-class outcome; the LangChain "ambient agents" framing calls this the **notify / ask / review** triad, and Tuezday has notify and review but not ask. An agent that asks a good question is more convincing than one that produces ten drafts.

### 1.3 The irony: the hard part is already built

Read `whats-actually-built.md` §12 again with agent eyes. The **external action** subsystem — action kinds, a ten-state lifecycle, idempotency keys, canonical payload fingerprints with stale detection, a five-scope policy tree resolving to `autonomous` / `human_required`, per-kind dispatch adapters, authorization batches, a decision log — is *precisely* the "bounded execution and layered safety controls" that the 2026 agent literature identifies as the thing everyone gets wrong.

Competitors shipping GTM agents right now are bolting governance on after the fact and discovering it is the hardest part. Tuezday built it first and is running a static workflow engine on top of it.

Similarly:

| Already built | What it is in agent terms |
|---|---|
| External actions + policy tree | Permission system / sandboxing — **the hard part** |
| Approval gate + conversational editor | Human-in-the-loop review + interrupt/resume |
| Context resolver + trace | Deterministic context assembly, already inspectable |
| Evidence store (R2R) + ranker | A retrieval tool |
| 16 task types + `TASK_INSTRUCTIONS` | Tool/skill descriptions |
| `apps/mcp` (6 tools) | A tool surface — pointed outward, unused inward |
| `priorities` + Review workspace | An agent inbox, missing the "ask" lane |
| `approvalDecisions` + ratings | **A labeled quality dataset, accumulated by accident** |
| Worker ticks | An event loop looking for an agent |

The gap is not capability. It is that none of this is exposed *to the model*, and there is no runtime that could consume it if it were.

### 1.4 What "feels intelligent" actually means

From the current design literature, four properties separate AI interfaces that sustain adoption from those abandoned after a month: **transparency** (show the reasoning at each decision point), **user control** (override, pause, redirect at any stage), **proactive status communication**, and **structured error recovery**. Clay attaches a full reasoning trace to every agent decision — that trace is a large part of why Claygent reads as intelligent rather than as a random-text generator.

Tuezday *computes* the trace already (`generations.sectionsJson`, the resolver inspector at `/resolver`) and then hides it on a debugging page. That is the cheapest perceived-intelligence win available and it requires no new AI at all.

---

## 2. The Design Principle

The instinct when someone says "make it agentic" is to replace the pipeline with an agent. That is the wrong move and it would destroy what is good about this codebase.

The current consensus pattern — orchestrator/worker with bounded execution — says the opposite:

> **Deterministic between steps. Agentic within a step.**

The engine owns sequencing, retries, budgets, idempotency, and gates. The agent owns judgment inside a bounded step with a tool allowlist, a step budget, and a required output schema. You get non-determinism where you want it (quality of judgment) and determinism where you need it (safety, cost, debuggability, tests).

This is also the reconciliation of the founder's two asks — "standardise the content pipelines" *and* "let agents execute them with intelligence." They are not in tension. **The pipeline becomes data; the steps become agentic.**

It also composes exactly with the campaign-opportunity control plane already designed in the discovery-intelligence doc: *one stable campaign lane is one content pipeline*. That doc defines the topology; this one defines what executes inside it.

---

## 3. The Nine Moves

Ordered by dependency, not by visibility.

### Move 1 — Gateway v2: a real agent runtime

Keep `generate()` untouched (everything depends on it). Add alongside it:

```ts
interface AgentTurnParams {
  messages: Message[];              // multi-turn, not one string
  system: string;                   // stable prefix → cacheable
  tools?: ToolDefinition[];         // name + description + zod/JSON schema
  responseSchema?: JsonSchema;      // constrained structured output
  maxSteps: number;                 // bounded execution
  maxTokens: number;                // bounded cost
}
interface AgentTurnResult {
  messages: Message[];              // full transcript
  toolCalls: ToolCall[];
  output: unknown;                  // schema-validated
  usage: { inputTokens; outputTokens; cachedTokens; costCents };
  stopReason: "complete" | "max_steps" | "max_tokens" | "needs_human" | "error";
}
```

Plus an `AgentRunner` that drives the loop: call model → dispatch tool calls → append results → repeat until done or a bound is hit. Every run persisted to an `agent_runs` table with the same trace discipline `generations` already has.

Three things fall out immediately, before any product change:

- **Structured output kills the parsing fragility.** Every `parseVariants` / score-extraction / match-parsing routine in the services becomes a zod schema from `packages/contracts`. Fewer bugs, less code.
- **Prompt caching becomes available.** Sprint 43 already implemented stable-prefix ordering in the resolver. That was built for budget enforcement; it is also exactly the precondition for caching the brain prefix across every call in a workspace. Agentic loops are 5–20× the tokens — this is how you afford them.
- **Usage accounting becomes real**, which the entitlement model (`assertWithinLimit`, "1k gens/mo") will need once a single "generation" can be twelve model calls.

Testable end to end with a fake gateway; no network in tests, per the existing composition-root rule.

### Move 2 — An internal tool registry

Not `apps/mcp` — that is a six-tool customer-facing shim over the public API. This is an *internal* registry where platform capabilities become model-callable tools:

```ts
interface Tool<I, O> {
  name: string;
  description: string;        // written for the model, not for docs
  input: ZodSchema<I>;        // from packages/contracts
  access: "read" | "propose"; // never "execute"
  run(ctx: { db; workspaceId; actor; budget }, input: I): Promise<O>;
}
```

**The safety model already exists and costs nothing to reuse.** Two tiers:

- **`read` tools** are unrestricted inside the workspace, because the auth guard's workspace-membership rule already scopes them. `search_evidence`, `get_brain_section`, `get_campaign_plan`, `list_recent_publications_with_metrics`, `find_similar_approved_drafts`, `get_persona`, `list_channel_guardrails`, `search_discovery_items`, `fetch_url`, `get_prior_posts_on_topic`.
- **`propose` tools never execute.** They mint an external action in `proposed` state and return its id. The existing policy tree then decides `autonomous` vs `authorization_required`. **An agent literally cannot do anything ungoverned, by construction, without a single new safety mechanism being written.**

This is the payoff for having built §12 first. It is worth being loud about internally: it is a genuine architectural advantage over anyone shipping GTM agents this year.

Ship an **Agent Inspector** UI alongside it — the `/resolver` page's sibling: run transcript, each step, tools called with arguments and results, tokens and cost per step, stop reason. Ship this *early*. It is what makes agentic behaviour debuggable for you and trustworthy for the customer.

### Move 3 — Pipelines as data, steps as agents

Today a content pipeline is implicit in the control flow of `automation.ts` (364 lines of branching). Make it an explicit, versioned, editable record — one stable lane = one pipeline:

```
pipeline: signal → social post
  step research    { tools: [search_evidence, get_prior_posts_on_topic,
                             fetch_url, list_recent_publications_with_metrics]
                     output: Brief, maxSteps: 6 }
  step angle       { tools: [get_campaign_plan, find_similar_approved_drafts]
                     output: Angle[3], maxSteps: 3 }
  step draft       { tools: [get_brain_section], output: Draft, maxSteps: 2 }
  step critique    { tools: [find_similar_approved_drafts, list_channel_guardrails,
                             get_brain_section]
                     output: Findings, maxSteps: 4 }
  step revise      { loop until score ≥ threshold, max 2 iterations }
  step propose     { propose_draft → approval gate }
  escalate_if      { confidence < 0.6 OR guardrail_uncertain → ask the founder }
```

The engine owns ordering, retries, budgets, idempotency, and the gate. Each step is a bounded agent turn. The pipeline definition is **data** — versioned like brain docs, editable in the UI, scoped per lane/campaign/workspace. That is the "standardised process" made real, and it is what lets one workspace run 100 pipelines without 100 branches of TypeScript.

Convert exactly one pipeline first (signal → social post), keep the old path behind a flag, and compare them on the metric you already collect: **approval rate at the gate**.

Note what this does to conflict #4 in the atlas (nine context-customisation knobs). Several of those knobs exist because a deterministic assembler must be told in advance what to include. An agent that can *fetch* what it needs makes some of them unnecessary. Treat that as a hypothesis to test, not a promise — but it points at simplification rather than more surface area.

### Move 4 — Grounded critique and retrieval few-shot

Two changes, the second of which is the highest quality-per-line-of-code change available anywhere in the platform.

**(a) A critic with tools.** Replace the blind scorer in `review.ts` with a critique step that can retrieve: pull the voice doc's actual examples, the last ten approved posts on this channel, the guardrail list, the campaign plan's pillars — and return *findings with citations*, not a number. Then a bounded revise loop (≤2 iterations). Reflection grounded in retrieved evidence is where output quality visibly jumps; ungrounded self-critique mostly produces confident hedging.

**(b) Retrieval-based few-shot from your own approval history.** Before generating, retrieve the 3 most similar **approved** drafts and the 2 most instructive **rejected** ones *with their rejection reasons*, and put them in context.

`approvalDecisions` is a labeled preference dataset that the platform has been accumulating since Sprint 5 and has never used as training signal at generation time — only as weekly synthesis fodder. This is the single cheapest way to make the product visibly learn: the founder will feel the difference after roughly twenty approvals, in a way that no amount of prompt tuning delivers.

### Move 5 — Memory faster than weekly

The learning loop today is: decisions → weekly LLM synthesis → a `now`-doc proposal → founder accepts. The governance is right. The latency is wrong — a correction made on Monday cannot influence Tuesday.

Add a fast layer underneath it. Every founder edit to a draft is a diff; extract the delta as a candidate rule ("never open with a rhetorical question", "always name the segment, not the persona"), store it with provenance, a confidence, and a hit count, and inject the top-N *relevant* rules as a new resolver section — traced like everything else.

Weekly synthesis then changes job: it **promotes** rules that have proven stable into the `voice` / `now` docs and **retires** ones that stopped firing. Nothing bypasses the founder-accepts gate; the fast layer is explicitly ephemeral and always visible in the trace.

This is the pattern behind why coding agents feel like they are paying attention (rules files plus learned memories), and it maps cleanly onto the architecture already in place.

### Move 6 — Evals: the unglamorous multiplier

Agentic systems without evaluation are a random-output generator with better marketing. This is the difference between products that feel intelligent and products that feel like a slot machine, and it is usually the thing teams skip.

Tuezday is in an unusually strong position here: you have months of `(signal, context, generated draft, founder decision, founder's edit)` tuples. Build a **replay harness**:

- Take N historical signals, run them through the current pipeline, compare against what the founder actually approved or rejected.
- Score with a rubric-based judge plus hard checks (guardrail violations, banned claims, length, CTA presence).
- Run it in CI on every pipeline-definition or prompt change.

Then "is the new critic better?" becomes a measurement rather than an argument. This is also what lets you ship agentic changes without fear of regression — which is what makes it safe to iterate fast on quality.

### Move 7 — Surface the intelligence in the product

Two changes, both mostly front-end, both disproportionate in perceived-intelligence terms.

**(a) Add the "ask" lane.** `priorities` and the Review workspace already give you notify and review. Add *ask*: a step that hits low confidence or an unresolvable ambiguity emits a question with the context needed to answer it in one click, and the run **suspends and resumes** on the answer. "I found a Series B announcement matching the Launch campaign — the plan doesn't say whether we can name investors. May I?" reads as a colleague. Silence followed by ten drafts does not.

This also finally resolves atlas conflict #7 (two ranking engines for Home): `priorities` and `next-action` both answer "what should you look at", and the agent inbox is the natural single answer — three lanes (notify / ask / review) over one queue.

**(b) Show the work on every artifact.** Every draft carries a collapsible "why this": the triggering signal, the brain sections used, the prior posts it learned from, the plan pillar it serves, what the critic flagged and what changed in revision. You compute all of this today and throw it away at the UI boundary.

**(c) On chat (Sprint 42):** superseded — see Move 9. The original reading ("table stakes, hold it until last") was right about the engineering and wrong about the product.

### Move 8 — Model routing and economics

Agentic loops cost 5–20× a single-shot call. Before this ships broadly:

- **Tier the models.** Cheap/fast for triage, matching, classification, dedupe. Frontier for the draft and critique steps where judgment is the product. The gateway already has provider flexibility (`fallback.ts`, `openrouter.ts`) — route per *step*, not per workspace.
- **Cache the brain prefix.** Move 1 makes this available; Sprint 43's stable-prefix ordering makes it effective.
- **Budget per pipeline run and per workspace**, surfaced in `/billing`. An entitlement model denominated in "generations" stops meaning anything once one generation is a twelve-step run.

### Move 9 — The conversation is the interface

*Added 2026-07-26 after founder review. This move revises Move 7(c), which held chat until last on the grounds that it is "table stakes, not the differentiator."*

That framing was right about the engineering and wrong about the product. It priced chat as a *feature* — one more page in a fourteen-module app — when it is actually the **retrieval layer for the product's own capabilities**.

Consider what Moves 1–8 produce: a tool registry of thirty-odd capabilities, pipelines that compose them, governed actions, memory, evals. Every one of those is reachable today only by a founder who knows which module owns it. The information architecture becomes the bottleneck on the intelligence. Chat removes that bottleneck — describe the outcome, the agent finds the path — and it is the *only* one of the nine moves a user experiences directly rather than inferring from better output.

Four capabilities, in dependency order:

**(a) Ask.** Threads bound to a resolved context bundle — the same bundle generation uses, not a system prompt with an export pasted in. Streaming, mandatory citations, compaction, every turn an `agent_run` so the Agent Inspector works on day one. This is the earliest point in the whole plan where the platform answers a question nobody explicitly programmed it to answer, and it lands right after Move 2.

**(b) See.** Tool results render as typed interactive cards, not prose. A draft comes back as a draft you can approve in place. Plus a `/` command layer and `@` entity pinning, because the cheapest and most reliable interaction is the one that never asks the model to infer intent.

**(c) Act.** Propose-tools in the thread. Chat inherits Move 7's governance wholesale — and introduces the one genuinely new attack surface in this document: it is the first place the model reads attacker-controlled text (fetched pages, discovery items) *while holding write tools in the same turn*. Untrusted content gets quarantined and marked; a write derived only from untrusted content requires explicit confirmation.

**(d) Delegate.** Detach work to background runs; spawn subagents that return distilled Briefs rather than transcripts; interrupt, steer, cancel. Then the ceiling lifts twice more — **standing agents authored in words** (which compile to Move 3 pipeline definitions, making the natural-language path the customer-editable path, gated by Move 6's evals) and **outbound MCP** (Tuezday as an MCP *client*, admin-registered servers, `propose`-class only, per-tool allowlist, off by default).

The discipline that keeps this from becoming a second product: **the chat layer owns no tools and no business logic.** If chat needs a capability, that capability becomes a registry tool — and pipelines, the inbox, the public API and `apps/mcp` all get it in the same commit. A tool that exists only for chat is a design defect.

---

## 4. What to Steal, and From Whom

| Source | The pattern | Tuezday's version |
|---|---|---|
| **Claude Code / Cursor** | Bounded tool loop; plan-then-execute; progressive-disclosure "skills" instead of one mega-prompt; rules + learned memories | `TASK_INSTRUCTIONS` becomes loadable, customer-editable skills per task×channel (a natural extension of Sprint 21's runtime-editable guidance); Move 5 is the memory half |
| **Clay / Claygent** | Reasoning trace on *every* agent decision; conversational agent building; test on real production data before deploying | Move 7b (show the work); Move 9d builds pipelines conversationally and **dry-runs them against historical signals** before activation |
| **Sierra / Decagon (support agents)** | Declarative policies + tools + guardrails, with a continuous supervisory eval loop over real traffic | Move 6 — you already own the labeled data they had to create by hand |
| **LangChain ambient agents / Agent Inbox** | notify / ask / review triad over an event stream; persistence layer that lets a run pause for human input and resume | Move 7a; the worker ticks are already the event stream |
| **Anthropic context engineering** | Compaction; structured note-taking; subagents that explore widely and return a distilled 1–2k-token summary | The research step will blow up context — run it as a subagent that returns a Brief, not a transcript. Move 9d makes this user-visible: delegation you can watch |
| **ChatGPT / Claude / Gemini apps** | Conversation as the entry point to every capability; streaming as a product feature; tool results rendered as interactive artifacts rather than prose; background tasks that report back | Move 9 — but grounded in the customer's own brain, campaigns and metrics, which is the thing a general assistant structurally cannot do |
| **Long-running-harness research** | A durable progress artifact with `passes` flags; verification before declaring done; agents must not be able to edit away their own success criteria | A pipeline run carries a checklist; a step cannot self-mark complete without producing the evidence the schema demands |

---

## 5. Honest Counterweights

This direction is not free, and the failure modes are real:

- **Non-determinism costs debuggability.** Mitigation: the deterministic-between/agentic-within split, plus the Agent Inspector, plus the replay harness. Do not skip the inspector to ship faster — it is load-bearing.
- **Cost and latency go up substantially.** Move 8 is not optional garnish.
- **Testing gets harder.** Contract: every agent step must be testable with a scripted fake gateway that returns canned tool calls. This is a hard requirement, consistent with the existing "every external dependency is an injectable option" rule.
- **Agentic is not automatically better.** Some steps genuinely should stay deterministic — dedupe, cadence filling, idempotency, publishing. Only make a step agentic where *judgment* is the bottleneck.
- **Scope discipline.** This is a multi-sprint direction with a real risk of becoming a rewrite. Every move below is designed to ship independently and to leave the existing path working behind a flag.

---

## 6. Proposed Sequencing

Framed as sprints, per the delivery workflow in `CLAUDE.md`. Phase H, running after or interleaved with the discovery-intelligence work (they compose: that doc defines pipeline *topology*, this one defines pipeline *execution*).

| # | Sprint | Scope | Ships |
|---|---|---|---|
| H1 | **Agent runtime foundation** | Gateway v2 (messages, tools, structured output, caching, usage), `AgentRunner` with bounds, `agent_runs` persistence. One proof tool (`search_evidence`). No product change. | Invisible. Fully unit-tested. |
| H2 | **Internal tool registry + Agent Inspector** | ~10 read tools with contracts schemas; actor/workspace scoping; the inspector UI. | A page where you watch it think. |
| H3 | **Pipelines as data** | Pipeline record + versioning + engine; convert signal→social-post; old path behind a flag; compare approval rates. | First agent-executed pipeline. |
| H4 | **Grounded critic + retrieval few-shot** | Tool-equipped critique step, bounded revise loop, approved/rejected few-shot retrieval. | Measurably better drafts. |
| H5 | **Eval / replay harness** | Historical replay, rubric judge, hard checks, CI integration. | Quality becomes a number. |
| H6 | **Preference memory** | Edit-diff → candidate rules → resolver section; weekly synthesis promotes/retires. | It visibly learns. |
| H7 | **Propose tools → external actions** | Agent can mint governed proposals across kinds. | It starts to act. |
| H8 | **Agent inbox: the ask lane + show-the-work** | Suspend/resume on questions; reasoning surfaces on every artifact; unify `priorities` + `next-action`. | It feels like a colleague. |
| — | *see Move 9* | Chat is no longer a trailing item. Its first sprint inserts immediately after H2 and its remaining four interleave — full sequencing in `prd-agentic-platform.md` §10. | The product stops requiring a map. |

**If only three ship:** H1, H2, and the first chat sprint. H1+H2 make agency possible and observable; chat is what the founder would feel first, and it is the only move a user experiences directly rather than inferring from better output. H4 (grounded critic) is the strongest fourth.

---

## 7. The Decision Being Asked For

Not "should we add AI agents" — the platform is already AI-shaped. The decision is:

> **Does the model get to participate in execution, or does it stay a text-completion function called from the middle of a flowchart?**

The infrastructure required to say yes safely — governed actions, policy scopes, idempotency, human gates, deterministic traces — is the part that is already built and that competitors are struggling with. What is missing is a runtime that can use it, and about ten tool definitions.

*Written 2026-07-26 against `main` @ `03329c4`. Move 9 added the same day after founder review.*
