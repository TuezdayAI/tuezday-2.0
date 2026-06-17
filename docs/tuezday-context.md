# Tuezday — Product Context

> Use this document to give an LLM full context about what Tuezday is and what it does.

---

## What Tuezday Is

Tuezday is a **GTM (go-to-market) orchestration platform** built around a shared, human-readable, editable memory called the **Central Brain**. It connects every channel a company uses for marketing and sales — content, outbound, paid ads, PR, CRM, lifecycle — so that each campaign starts with the full context the company has already earned, instead of resetting from scratch.

The core bet: **GTM should be a compounding system, not a series of isolated campaigns that each start from zero.**

---

## The Problem It Solves

Modern GTM teams run many channels simultaneously: content, LinkedIn, outbound email, paid ads, CRM, PR, newsletters, and more. But learning does not travel between them.

- An ad campaign learns one pain point converts. The outbound sequence never sees it.
- A sales call reveals a recurring objection. The landing page still ignores it.
- The founder writes a post that finally explains the product well. The next email campaign starts from a blank prompt.

Every new tool, new hire, and new AI chat needs the same context re-explained from scratch. That is the gap Tuezday closes.

---

## The Central Brain

The Brain is the product's moat. It is **visible, editable, and used by every module**. It is not hidden inside embeddings.

Five human-editable brain documents per workspace:

| Doc | What it captures |
|---|---|
| `soul` | Why the company exists; the founder's honest POV |
| `icp` | Ideal customer profile; who the product is actually for |
| `voice` | Tone, word choices, what to avoid; how the company sounds |
| `history` | What has been tried, what worked, key proof points, past campaigns |
| `now` | What matters this week: current push, active offer, live campaigns |

These five docs are the primary context source. A **Context Resolver** layers them with overlays (channel, campaign, persona) to produce a deterministic, inspectable context bundle before every LLM call. The resolver output is always readable — the user can see exactly what went into a generation before it happens.

---

## Major Features

### 1. Brain Editor
Create and edit the five brain docs per workspace. Every save is versioned. Brain completeness score shows what is missing. Full-brain markdown export.

### 2. Context Resolver
Deterministic resolution engine: workspace brain + channel overlay + campaign overlay + persona overlay → ordered context bundle with a trace. The resolver preview lets a user pick persona + channel + task type and read the exact bundle before generating anything.

### 3. Personas and Overlays
Multiple personas per workspace (e.g. CEO voice vs. company page). Each persona adds or overrides voice/tone in the resolved context. Channel and campaign overlays further shape what is included.

### 4. Generation Sandbox
Four task types out of the box: LinkedIn post, cold email opener, ad copy variant, landing page hero. The resolved context is shown before generation. Every output can be rated (`accepted` / `needs edit` / `rejected`), and those ratings are stored as training signals.

### 5. Approval Gate
Every generated output goes through a state machine: `draft → pending_review → edited ↔ pending_review → approved | rejected`. Humans stay in control. The approval queue is the main trust interface. All modules (content, outbound, ads, PR) reuse this same gate.

### 6. Content Module
Manual signal input (paste a Reddit/X/LinkedIn observation) → brain-resolved draft in the right voice → approval → publish or export. Signals discovered from sources (RSS, Reddit, X) flow into a signal inbox for triage.

### 7. Campaigns
A campaign object packages: objective, KPI, timeframe, audience slice, messaging pillars, channels, and personas. Campaigns plug into the Context Resolver as a campaign overlay, making every resolved context campaign-aware. All drafts, outbound sequences, and ad creative are tagged to a campaign. Campaign-level reporting ties output back to results.

### 8. Signal Discovery
Worker-polled signal adapters (RSS, Reddit, X, LinkedIn) feed a signal inbox. Each signal gets relevance-scored and can be triaged: skip, or accept into a content draft or PR pitch. Accepted signals use the standard brain-resolve → generate → approve path.

### 9. RAG Corpus (R2R)
Long-tail evidence retrieval: uploaded documents (website copy, past posts, call notes, sales decks) are indexed in an R2R instance behind a Brain Gateway boundary. Retrieved chunks are merged into the resolver bundle with citations and a retrieval trace. Tuezday owns the retrieval policy; R2R is behind a service boundary.

### 10. Learning Loop
Training examples assembled from approval decisions and edits. Engagement metrics imported (manual/CSV initially). A weekly `now` synthesis proposal surfaces what the system thinks should be updated — the founder reviews and accepts before anything writes to the brain. Every campaign ends with the brain knowing more than it did at the start.

### 11. Outbound Module
Lead/account input via CSV. Brain-personalized cold email drafts per lead, driven by the resolver with outbound channel overlay. Approval queue reuse. CSV export to external send infrastructure (Smartlead, Instantly). Tuezday never builds deliverability or warmup infra.

### 12. Connector Fabric (Nango)
A connector registry and connection health layer. Nango runs as a separate service (Elastic license — its code never enters Tuezday). All OAuth-based integrations (CRM, social, ad platforms) are managed through this fabric. Webhook/event contract is standardized.

### 13. CRM Read/Write
First connector: Freshsales (api_key auth) behind a provider-agnostic `CrmAdapter` interface. Read contacts and deals; write back enriched context and drafted copy. HubSpot, Pipedrive, Salesforce follow the same adapter pattern. Tuezday is not a CRM — the CRM is a source and destination, not the brain.

### 14. Ads Reporting
Native ad metric model: `ad_account`, `ad_campaign_metric` (daily grain: spend, impressions, clicks, conversions). Tuezday owns this model regardless of source. First platform: Meta Ads. Worker polling job; manual "sync now". Campaign-linked metrics surface on the campaign reporting view. CSV import fallback for accounts not yet connected.

### 15. Ad Creative Generation
Brain-resolved, platform-ready ad copy through the same resolve → generate → approve loop. Hard format constraints enforced by contracts (e.g. Google RSA: 15 headlines ≤30 chars; Meta primary text / headline / description). Variants generated as a set. Approved creative is exportable in paste-ready / CSV form. Where Sprint 14 metrics exist, performance shown next to the creative that ran.

### 16. PR & Media Outreach
Media contact model (journalist, publication, podcast — beat, outlet, past coverage notes). PR campaign type: announcement, thought-leadership pitch, or reactive response to a discovered signal. Brain-personalized pitch drafts per contact. Press boilerplate / press-kit generated from brain docs. Approval queue reuse; export to CSV/email client. No sending infra.

### 17. Social Publishing
Approved content drafts publish directly to connected social accounts. Native scheduling through the connector fabric (Nango OAuth). Platforms: Reddit, X, LinkedIn, Instagram (in order of API friction). Per-platform constraints validated before publish. Published URL and status stored on the content item.

### 18. Native Ads Execution
Draft ad campaign object in Tuezday → approve through the gate (human approves spend before any API call) → launch on the ad platform. Hard guardrails: per-campaign budget cap, workspace-level daily spend cap, pause-all kill switch. Status sync back from the platform via the existing reporting polling job. First platform: Meta.

### 19. Users, Teams & Auth
Email + password accounts, opaque bearer sessions. Workspace membership with owner / member roles. Invite flow. Approval gate decision log and brain-doc version history record the acting user.

### 20. Dashboard / Command Center
Home screen showing: active campaigns, today's approval queue, signals worth acting on, connected modules, what changed this week, what the system recommends next. Navigation: Brain, Campaigns, Signals, Approval Queue, Outbound, Ads, PR, Connectors, Reporting.

---

## What Tuezday Is Not

- **Not a CRM.** Integrates with CRMs; does not replace them.
- **Not an ads manager.** Generates creative and reports on results; does not manage bids, budgets, and placements in detail.
- **Not a generic AI writer.** Every generation starts from the company's brain, not a blank prompt.
- **Not a content scheduler.** Scheduling is a feature, not the product.
- **Not Zapier with prompts.** Tuezday makes GTM decisions using context; it is not a data-pipe automation tool.

---

## Technical Stack

- **Language:** TypeScript everywhere (web, API, worker, contracts).
- **Monorepo:** npm workspaces — `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/brain`, `packages/modules`, `packages/integrations`.
- **Web:** Next.js App Router (`apps/web`, port 3000).
- **API:** Fastify (`apps/api`, port 3001). Routes → services → DB.
- **DB:** SQLite via Drizzle ORM (Postgres migration planned when infra grows). All DB access inside `apps/api/src/db`.
- **Contracts:** Zod schemas in `packages/contracts`, shared by API and web. Enum vocabularies (brain doc types, approval states, output ratings, ad format limits) defined here and nowhere else.
- **LLM:** Google Gemini behind a provider-agnostic LLM gateway with full prompt/response trace logging. Providers never touched directly by routes or services.
- **Tests:** Vitest. API tested via Fastify `inject` (no network). In-memory SQLite for test isolation.
- **Integrations:** Nango as a separate service for all OAuth connector flows. Never mixed into Tuezday code.

---

## Build State (as of 2026-06-13)

All 20 planned sprints are built. Sprints 14–20 are awaiting founder acceptance testing. Sprint 13 (CRM read/write) is the last accepted and frozen sprint.
