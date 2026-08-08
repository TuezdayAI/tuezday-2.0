# Canonical Domain Model — Review & Blaze.ai Comparison

**Date:** 2026-07-11
**Status:** Review of the proposed architecture revamp (pre-spec). Not yet an approved design.

## The proposed model under review

```
Workspace
└── Campaign
    ├── Plan Revisions
    │   └── Lanes
    ├── Content Packages
    │   ├── Sources
    │   └── Deliverables
    │       └── Variants
    └── External Actions
        └── Outcomes
```

- **Campaign** — universal parent for GTM work. Evergreen activity uses system-managed campaigns rather than campaign-less records.
- **Plan revision** — immutable snapshot of campaign goals, audiences, topics, dates, evidence, and planned output. Editing a campaign creates a revision so generated work remains reproducible.
- **Lane** — reusable production rule within a plan: persona, account, channel, format, audience, frequency, schedule, CTA, guidance, reactive capacity, and external-action policy.
- **Content package** — one campaign-specific angle or narrative derived from one or more signals, campaign topics, uploaded sources, existing content, or a manual brief. A signal may create several packages across campaigns or within one campaign.
- **Package source** — many-to-many provenance linking signals, evidence, URLs, prior content, product material, and manual instructions. Prevents unsupported generation and enables citations.
- **Deliverable** — one intended piece of work (e.g. "Founder persona LinkedIn carousel for Tuesday"). Records the lane, deadline, dependency snapshot, sufficiency result, lifecycle, and fulfillment status.
- **Variant** — candidate execution of a deliverable. Initially links to the existing draft and its media. Regeneration creates a new variant instead of overwriting lineage.
- **External action** — normalized intent to publish, send, reply, launch spend, or change a live campaign. Carries the resolved autonomy policy and approval requirement.
- **Outcome** — platform receipt and normalized metrics attributed back through action → deliverable → package → campaign, persona, audience, account, and source signal.

Existing `drafts`, `publications`, `launches`, `launch_messages`, `ad_launches`, and metrics tables remain operational records during migration; the graph becomes the control plane above them.

## Verdict

The model is sound and formalizes things the codebase already does implicitly in scattered ways — all nine objects are worth keeping. The gaps:

1. **Lane** overlaps almost entirely with the existing `posting_cadences` table and the two must not coexist.
2. The **Brain/context-resolver snapshot** is missing from the model even though it's the moat.
3. There are **two distinct approval gates** hiding inside one.
4. There's **no calendar/slot projection**, which Blaze shows is the surface users actually live in.

## What's right and worth keeping

- **Plan revisions.** Today `campaigns` is a mutable row; editing `pillarsJson` or `audience` silently changes the meaning of every generation that referenced it. Immutable revisions match the philosophy already applied to brain docs (`brain_document_versions`) and approval decisions (`contentSnapshot`).
- **Variants instead of overwriting.** `drafts` keeps only `originalContent` + `content` — regeneration lineage is destroyed today. Variants fix a real defect.
- **Package sources as many-to-many.** `drafts.sourceSignalId` is a single nullable column; a piece grounded in two signals plus an uploaded PDF is unrepresentable today. Also directly serves the citations requirement.
- **External action as one normalized intent.** There are currently three parallel execution paths with three separate policy surfaces: `publications` (+ `social_automation_settings`, per-campaign `automationMode`/`autoDailyCap`), `ad_launches` (+ `ad_settings`, its own decision log and state machine), and `launches`/`launch_messages`. Unifying "resolved autonomy policy + approval requirement" into one object is the single highest-leverage part of this plan.
- **Control plane above existing records, not a rewrite.** Correct call. Pin down the write direction explicitly in the spec: the new graph *creates* the operational records (external action → inserts a `publications` row), never dual-write from both sides, or the migration becomes an exercise in reconciling two sources of truth.

## What to fix or clarify

### 1. Lane vs. `posting_cadences` — pick one

A Lane (persona, channel, audience, frequency, schedule, campaign-bound) is ~90% a posting cadence plus guidance and policy. If both exist, every scheduling question has two answers. **Recommendation:** Lane absorbs cadence; the cadence table becomes Lane's schedule component during migration. `docs/plans/context-discovery-gap-assessment.md` already notes discovery sources have no "content lane" representation — so also decide whether discovery routing (`signal_matches` scores per persona×campaign) should target *lanes* rather than campaigns. That's arguably the natural landing spot: a signal matched to a lane already knows persona, channel, format, and policy.

### 2. Lane identity across revisions

Lanes live "within a plan revision," but deliverables reference a lane and outcomes attribute back through it. If revision N+1 recreates lanes as new rows, in-flight deliverables and historical attribution orphan. Give lanes a **stable identity** (lane id) with **revision-scoped configuration**, so "the founder-LinkedIn-carousel lane" is one thread through time.

### 3. Split the two approvals explicitly

The model puts lifecycle on Deliverable and approval requirement on External Action — good instinct, make it doctrine:

- **Content approval** — is this variant on-brand and correct? The existing `transitionTo()` state machine from `packages/contracts`, applied at the **variant** level.
- **Action authorization** — may this leave the building / spend money? On the **external action**, per the lane's autonomy policy.

Today approving a draft implicitly authorizes publishing under some automation modes; separating them is what makes "auto-generate freely, gate only at the boundary" possible per lane.

### 4. Add the Brain to the dependency snapshot

The deliverable's "dependency snapshot" mentions plan/lane but not the resolved context bundle. For Tuezday specifically, reproducibility means: which **brain doc versions**, which overlays, which guidance overrides were in effect. `generations.sectionsJson` already captures this at the LLM-call level; the deliverable should reference it formally. Otherwise "generated work remains reproducible" is only half true — the plan can be replayed but not the brain state.

### 5. Add a calendar/slot projection

Deadlines live on deliverables and schedules on lanes, but nothing in the model answers "what does next week look like?" cheaply. Not necessarily a new table — but the spec should name the calendar as a first-class **view** over deliverables + external actions, and lanes should **materialize deliverables ahead of time** (e.g., mint the next 14 days of deliverables from lane schedules) so the calendar shows planned-but-unfilled slots, not just finished work. (This is Blaze's core lesson — see below.)

### 6. Type the package-source edge

"Signal," "cited evidence," "repurposed from prior content," and "manual instruction" behave differently: citations must surface in output, instructions must reach the prompt, repurposing implies derivation lineage. Make the relationship kind an **enum on the source link** (defined in `packages/contracts`, per convention) rather than inferring it from the target's type.

### 7. Attach outcomes at the variant level

Outcomes attribute through action → deliverable → package — but the action published a specific **variant**. Variant-level attribution turns outcomes into training signal: it upgrades the learning loop from human ratings (`generations.rating`) to behavioral ratings, feeding `now_syntheses`. That's a differentiator; don't lose it one level up. Conversely, keep the normalized metric core small (impressions, engagements, clicks, spend — roughly what `publication_metrics` / `ad_campaign_metrics` already hold); cross-platform metric normalization beyond that is a tarpit.

### 8. System-managed evergreen campaigns — fine, with a flag

Add `kind: user | managed` and exclude managed campaigns from signal matching, campaign pickers, and LLM prompt context, or the "Evergreen" pseudo-campaign will pollute `signal_matches` scoring and dashboards.

### 9. Two candidates to trim from v1

- **Reactive capacity** on lanes is a scheduling-policy refinement addable later without schema pain.
- **"Account"** in the lane definition is ambiguous — if it means the social account/connection (`persona_social_accounts`), name it that; if it means an ABM target account, that's a different object not yet modeled and shouldn't be smuggled in via a lane field.

## How Blaze.ai does it, and what to take

Blaze's pipeline: a **Brand Kit** (scraped site + tone sliders + do/don'ts — their analog of the Brain, but static and not versioned) feeds a generated 12-month strategy, which **materializes directly into calendar slots** per channel; each slot gets platform-specific drafts; content sits in queues with approval chains routed by channel/topic/risk; a **repurposing engine** turns one asset into "60+" derivative pieces. Analytics stop at reach/engagement — reviewers consistently note there's no real attribution, no provenance, and no reproducibility.

Insights derived:

- **Calendar-first UX.** Blaze's entire product surface is "strategy becomes a populated calendar." The proposed model is graph-first, which is the right *backend*, but users will judge it by whether the calendar view falls out naturally — hence fix #5.
- **Package → per-channel deliverables, generated together.** Blaze generates the X/Instagram/LinkedIn versions of one idea as a set; users complain about friction moving content *between* platforms when it isn't a set. The Content Package → multiple Deliverables shape already supports this — make "fan a package out across a lane set" the default generation flow, not N independent requests.
- **Repurposing is a flow, not just provenance.** The package-source link *records* repurposing; Blaze shows it should also be an *action* ("turn this blog post into 8 packages across these lanes"). Cheap to add on top of the model as drawn.
- **Approval routed by risk maps to the action policy.** Blaze routes approval chains by channel/topic/risk level — validation that autonomy policy belongs on the lane/action, resolved per action, exactly as drawn.
- **Where Tuezday is structurally ahead — protect it.** Blaze has no plan revisions, no source provenance/citations, no variant lineage, and no outcome→source attribution. Those four are precisely the parts of the model a "move fast" instinct would cut first. They're the moat; the Blaze comparison is the argument for keeping them.

### Sources

- [Blaze.ai homepage](https://www.blaze.ai/)
- [Blaze Brand Voice help doc](https://help.blaze.ai/en/articles/9541323-brand-voice)
- [AppCritica Blaze AI review 2026](https://www.appcritica.com/blog/blaze-ai-review-can-this-ai-marketer-really-run-your-content-engine/)
- [quso.ai Blaze review](https://quso.ai/blog/blaze-ai-review-alternatives)
- [Blaze content creation tutorial](https://www.blaze.ai/tutorials/content-creation)
- [Blaze for agencies](https://www.blaze.ai/blog/how-marketing-agencies-use-blaze)
- [Medium in-depth review](https://medium.com/@bernardloki/blaze-ai-in-depth-review-the-ultimate-content-creation-and-marketing-tool-for-businesses-9f9c4d3e509b)
- [fahimai how-to](https://www.fahimai.com/how-to-use-blaze-ai)
- [Blaze FAQ](https://www.blaze.ai/faq)
