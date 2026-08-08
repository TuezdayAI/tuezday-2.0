# Consolidated Tuezday UI/UX Revamp Design

> Status: approved design synthesis
>
> Date: 2026-07-12
>
> Product principle: **Blaze-simple at the surface, Tuezday-complete underneath.**

## 1. Purpose

This document combines the strongest elements of:

- `docs/ui-ux-revamp-guidelines.md`, which defines Tuezday's product architecture, capability coverage, campaign context, journey standards, migration constraints, and quality bar.
- `ExportBlock-dd93eab7-0fe7-4596-a1ad-45545b267e9a-Part-1/Blaze UX & UI Teardown 59614bf9d24083f69d8301a70eb2bfe4.md`, which documents Blaze's live shell, visual grammar, status language, activation patterns, creation flows, calendar, approval queue, and conversational editor.
- [tuezdayai.com](https://tuezdayai.com/), which is the design-language authority for Tuezday's typography, palette, geometry, motion, and editorial control-room character.

This is a companion to the existing revamp guideline, not a replacement. The guideline remains the product doctrine; this document resolves the experience direction and delivery sequence needed to execute it.

## 2. Synthesis Decision

Blaze supplies a proven operating loop:

`Generate → Review → Approve → Publish → Learn`

Tuezday expands that loop into a governed, multi-channel GTM system:

`Connect → Remember → Detect → Draft → Review → Authorize → Execute → Learn`

The product should feel as simple as Blaze at the point of use while preserving Tuezday's differentiators:

- Editable Brain and evidence
- Campaign plan history
- Cross-channel content packages and variants
- Organic, outbound, PR, paid, lifecycle, and web actions
- Separate content approval and external-action authorization
- Provenance, attribution, and inspectable context
- Outcome-driven learning with human acceptance
- Workspace and campaign-level governance

## 3. What to Take, Extend, and Reject

| Source idea | Decision for Tuezday | Reason |
|---|---|---|
| Campaign-centered operating context | Adopt and deepen | It connects planning, work, approvals, execution, outcomes, and learning. |
| Weekly Strategy → Campaign → Post hierarchy | Adapt | Weekly cadence is a useful template, but Tuezday must support launches, evergreen work, events, reactive signals, PR, outbound, and paid campaigns. |
| Home "Up next" module | Adopt and deepen | Tuezday can rank approvals, authorization, replies, failures, signals, risks, and learning updates. |
| Calendar as an operational work surface | Adopt | Planning, review, regeneration, scheduling, and execution status belong together. |
| Unified status pills across the product | Adopt as foundational | Shared state language makes an approval-led product scannable. |
| Three-panel conversational editor | Adopt and extend | Tuezday adds evidence, provenance, variants, authorization, policy, and outcome history. |
| AI-first creation with field-level regeneration | Adopt | Users should provide direction and judgment rather than begin from blank prompts. |
| Pre-seeded workspace | Adopt with clear labeling | It demonstrates value before setup without confusing sample and live data. |
| Inline setup actions | Adopt | Missing connections should be resolved where they block work. |
| Gated value previews | Use selectively | Honest previews can explain future value; fabricated data or manipulative locks are excluded. |
| Persistent credits and upgrade controls | Do not copy by default | They belong only if Tuezday's commercial model requires them. |
| Unverified social proof and artificial urgency | Reject | Activation must remain credible and product-led. |
| Blaze branding and visual palette | Reject | Tuezday's live website is the visual authority. |

## 4. Experience Principles

1. **The system prepares; the human directs and authorizes.**
2. **Campaign is the durable context, not the only entry point.**
3. **Every screen reveals the next useful action.**
4. **Status language is global and deterministic.**
5. **Generated work is the default starting point.**
6. **Advanced machinery is inspectable without dominating the workflow.**
7. **Every output can explain why it exists.**
8. **Approval of content and authorization of external action remain distinct.**
9. **Partial success is reported honestly and recoverably.**
10. **Metrics culminate in a decision, explanation, or action.**
11. **The product uses Tuezday's brand language, not Blaze's trade dress.**
12. **Shared patterns are governed centrally and tested as complete states.**

## 5. Information Architecture

### 5.1 Global shell

| Area | Surfaces | Purpose |
|---|---|---|
| Operate | Home, Calendar, Campaigns, Review | Daily planning, prioritization, approval, and execution |
| Grow | Discover, Audience, Ads, Insights | Opportunities, recipients, paid activity, and performance |
| Foundations | Brain, Content Preferences, Integrations | Reusable context, generation rules, and connections |
| Work library | Create New, Search, Recent, Projects, Media | Cross-campaign content and assets |
| Workspace | Team, Billing, Notifications, Developer, Activity, Settings | Administrative and technical configuration |

The persistent shell contains:

- Workspace switcher
- Collapsible grouped navigation
- Global Create action
- Search or command access
- Notifications
- Help
- User menu

Commercial controls appear in the persistent shell only when they are essential to the actual Tuezday plan and billing model.

### 5.2 Review

Approvals and Inbox become sibling tabs inside **Review**.

- **Approvals** answers: "What must I authorize?"
- **Inbox** answers: "Who responded, and what should I do?"

They reuse campaign context, status language, assignment, previews, filters, queue navigation, and item-detail anatomy.

### 5.3 Campaign workspace

Each campaign is a focused workspace with:

`Overview · Plan · Work · Calendar · Review · Channels · Results`

- **Overview:** progress, attention, blockers, upcoming work, and next action
- **Plan:** objective, audience, strategy, schedule, context, automation, and plan history
- **Work:** content sets and channel items
- **Calendar:** campaign-filtered planned, scheduled, and executed work
- **Review:** campaign-filtered approval and authorization queue
- **Channels:** organic, outbound, PR, ads, lifecycle, and other configured lanes
- **Results:** outcomes, comparisons, learning suggestions, and accepted changes

### 5.4 User-facing work hierarchy

The interface uses:

`Campaign → Content set → Channel item`

- A **campaign** owns the objective, audience, schedule, automation, governance, and outcomes.
- A **content set** groups one source or idea across formats, variants, and destinations.
- A **channel item** is the concrete post, email, ad, pitch, message, web edit, or other action that can be previewed and authorized.

Backend terms such as plan revision, lane, deliverable, and resolver remain available in advanced or technical contexts when they add real value.

### 5.5 Global creation

Create New is available globally. Users may draft exploratory or one-off work outside a campaign, but scheduling, publishing, sending, launching, spending, or changing targeting requires selecting or creating a campaign.

## 6. Golden Operating Loop

The first vertical slice is:

`Home priority → Campaign context → Review queue → Conversational editor → Approval/authorization → Calendar → Execution result`

### 6.1 Home

Home is an attention control room led by one ranked **Up next** queue. It answers within five seconds:

1. What requires attention now?
2. Why does it matter?
3. What happens if it is ignored?
4. What is the next action?

Candidate priorities include:

- Content review
- External-action authorization
- Replies requiring action
- Execution failures
- Missing or unhealthy connections
- High-value signals
- Campaign risk
- Stale work after a plan change
- Suggested Brain or guidance updates

Upcoming work and compact campaign health follow the ranked queue.

### 6.2 Review queue

Review supports:

- Approval and Inbox tabs
- Filters for campaign, channel, risk, owner, status, and due time
- Grouping by campaign or urgency
- Previous and next navigation through the filtered queue
- Batch approval only for equivalent, low-risk items
- Clear separation between content approval and external-action authorization
- Assignment, comments, and decision history
- Explicit blocked, stale, and partial-success states

### 6.3 Conversational editor

The primary editor uses three coordinated regions:

| Region | Responsibility |
|---|---|
| Guidance | AI recommendations, evidence-backed explanations, conversation history, and natural-language revision |
| Preview | Destination-accurate output, channel switching, responsive states, variants, and user feedback |
| Execution | Schedule, destinations, campaign, authorization, automation policy, and focused edits |

Tuezday-specific capabilities include:

- "Why Tuezday made this" disclosure
- Brain, persona, campaign, guidance, signal, and evidence inputs
- Source citations and provenance
- Variant comparison and lineage
- Plan-change staleness warnings
- Separate content and external-action decisions
- Policy and automation explanation
- Execution and outcome history

Direct manipulation remains available through focused tools. Conversation is the default refinement path, not the only editing capability.

### 6.4 Calendar

Calendar combines:

- Multiple time views
- Campaign and channel filters
- Comfortable and compact densities
- Planned-but-unfilled commitments
- Generated work awaiting review
- Approved and scheduled work
- Active executions and results
- Preview, selection, regeneration, rescheduling, and recovery actions

Calendar uses the same item anatomy and status labels as Home, Review, and campaign Work.

## 7. Status and State System

Every state uses text, icon, and color. Color never carries meaning alone. A label has one meaning across Home, Campaigns, Calendar, Review, the editor, and Insights.

### 7.1 Canonical state families

| Family | States |
|---|---|
| Needs attention | Draft, Review required, Authorization required, Changes requested |
| In progress | Generating, Regenerating, Scheduling, Publishing, Sending, Launching |
| Ready and healthy | Approved, Authorized, Scheduled, Active, Connected, Completed |
| Blocked or degraded | Setup required, Connection lost, Policy blocked, Partially failed, Failed, Stale |
| Informational | Paused, Superseded, Archived, Experimental |

### 7.2 State rules

- Objects may expose content state and execution state separately.
- "Approved" never implies "Authorized" unless one explicit policy decision covers both.
- "Scheduled" identifies an accepted future execution time.
- "Active" identifies a currently operating campaign or channel action.
- "Partially failed" lists successful and failed destinations separately.
- "Stale" explains which plan or context change affected the work.
- Blockers always expose cause, impact, preserved work, and recovery.

## 8. Activation and First Value

Activation follows:

`Website → Brain → Persona/guidance → Integrations → Sample review → First campaign → First approved output`

Adopted activation patterns include:

- Clearly labeled sample workspace populated with Tuezday-specific work
- One ranked next action rather than an undifferentiated checklist
- Integration progress and a recommended next connection
- Honest effort estimates
- Inline connection and setup actions
- Realistic value previews for unavailable analytics
- Guided transition from sample content to live workspace data

The sample workspace must demonstrate evidence, signals, cross-channel work, approval, and learning. It must never masquerade as the user's actual performance.

## 9. Tuezday Design Language

The live website is the design-language authority. Blaze remains a reference for operational density, content anatomy, and interaction clarity.

### 9.1 Brand character

The product should feel like an **editorial GTM control room**:

- Precise and intelligent
- Technical without being developer-only
- Opinionated rather than generically "AI"
- Calm on working surfaces
- Expressive when showing relationships, channels, intelligence, and milestones

### 9.2 Typography

- **Archivo:** page titles, major section headings, campaign names, and prominent metrics
- **Inter:** navigation, controls, forms, tables, and body copy
- **JetBrains Mono:** status, timestamps, scores, versions, evidence references, and compact uppercase labels

The interface retains tight heading tracking and clear contrast between editorial headings and utilitarian controls.

### 9.3 Foundation tokens

The website establishes these source tokens:

```css
--bg: oklch(96.6% .005 256);
--bg-sunk: oklch(94.4% .006 256);
--surface: oklch(99.5% .003 256);
--ink: oklch(20.5% .013 264);
--ink-2: oklch(40.5% .012 264);
--ink-3: oklch(53.5% .01 264);
--line: oklch(85.5% .008 264);
--line-soft: oklch(90.5% .006 264);
--accent: oklch(55.5% .15 256);
--focus: oklch(55% .16 256);
--danger: oklch(55% .2 27);
--ok: oklch(55% .13 150);
```

The implementation plan will map these brand tokens into semantic application tokens rather than scattering raw values through components.

### 9.4 Spectrum vocabulary

Tuezday's coral, amber, lime, cyan, indigo, and magenta spectrum is used for:

- Channel identity
- Signal sources
- Brain document categories
- Journey stages
- Charts and comparisons
- Provenance and relationship visualization
- Branded milestones and education

Spectrum colors do not replace semantic workflow colors. The spectrum bar appears sparingly in onboarding, sample states, milestone completion, and major branded panels.

### 9.5 Geometry

- `4–6px` radii for compact controls, chips, and metadata
- Approximately `9px` for buttons and standard inputs
- `16px` for major panels, drawers, and modals
- Fully rounded forms only for statuses, toggles, and counters
- One-pixel rules as the default separator
- Six-column structural grids for large workspace layouts
- Small square markers and corner ticks as Tuezday details

Marketing-page grain, oversized spectrum fields, and dramatic dark sections are reserved for onboarding, education, and milestone moments. They do not sit behind dense daily work.

### 9.6 Motion

- Press feedback: approximately `130ms`
- Fast transitions: approximately `180ms`
- Standard transitions: approximately `240ms`
- Drawers and large spatial transitions: approximately `420ms`
- Soft ease-out movement
- Subtle press scaling
- Visible indigo focus rings
- Complete reduced-motion behavior

## 10. Responsive Scope

The first release supports:

- Full operation at desktop and common laptop widths
- Functional tablet and narrow-browser layouts through collapsible panels and drawers
- Mobile-first support for Home triage, Review, approval, Inbox, notifications, and execution monitoring

Complex campaign planning, visual design, and bulk operations may use a clear desktop continuation boundary in the first release. The boundary must preserve the user's place and explain what is unavailable.

## 11. Shared Component and State Requirements

The shared system includes:

- Application shell and navigation
- Page headers and contextual action bars
- Status badges and channel/content glyphs
- Buttons, fields, selectors, toggles, chips, and validation
- Cards, tables, lists, galleries, and calendars
- Search, filters, sorting, grouping, density, and saved views
- Drawers, modals, popovers, and full-page workflows
- Preview frames and destination switchers
- Creation wizards and regeneration controls
- Toasts, progress, background jobs, and retry behavior

Every component defines:

- Default, hover, focus, selected, disabled, destructive, and read-only states
- Empty, sample, loading, generating, success, warning, partial-success, error, blocked, and stale states where applicable
- Keyboard order and visible focus
- Narrow-screen behavior
- Reduced-motion behavior

## 12. Delivery Stages

### Stage 0: Establish the safe baseline

- Rehearse and complete GTM/Sprint 41 integration
- Preserve current UI changes and GTM contracts
- Verify full tests, type checking, and production build
- Freeze the verified commit as the revamp baseline

**Gate:** Revamp implementation starts only from the verified baseline.

### Stage 1: Lock the experience contract

- Build the canonical capability registry
- Resolve navigation and route migration
- Confirm user-facing terminology
- Extract and codify Tuezday website tokens
- Define the semantic status dictionary
- Map golden-loop states and analytics
- Audit required APIs and routes

**Gate:** Every golden-loop capability has a destination, state model, and migration treatment.

### Stage 2: Build the shared control-room system

- Implement the shell and responsive navigation
- Implement semantic design tokens
- Build shared status, content, preview, form, data, overlay, and feedback patterns
- Build the sample-workspace framework
- Document components and validate accessibility

**Gate:** Shared patterns pass visual, keyboard, contrast, responsive, and state-coverage review.

### Stage 3: Deliver the golden operating loop

Build:

`Home → Campaign → Review → Conversational editor → Approval/authorization → Calendar → Execution result`

Use realistic populated data and include queue navigation, destination previews, natural-language revision, evidence disclosure, partial failure, and recovery.

**Gate:** A user identifies priority work within five seconds and completes the loop without backend terminology.

### Stage 4: Complete activation and first value

- Website-to-Brain setup
- Persona and guidance review
- Integration checklist
- Pre-seeded sample campaign
- First real campaign
- First approval and connection
- Sample-to-live transition

**Gate:** A new workspace reaches its first useful approved output and understands the next action.

### Stage 5: Expand by journey wave

1. Campaign planning, automation, and plan history
2. Discover and reactive creation
3. Brain, evidence, and advanced context
4. Audience, outbound, PR, and Inbox
5. Ads, budget governance, experiments, and Insights
6. Settings, team, billing, notifications, and developer tools

Each wave reuses the shared shell, status system, editor, preview, and recovery patterns. New shared patterns are added centrally before they spread.

### Stage 6: Cut over and optimize

- Redirect, embed, retain, or retire legacy routes
- Verify capability reachability
- Run regression, accessibility, responsive, and journey suites
- Compare product measures against the pre-revamp baseline
- Remove sample or compatibility paths only after verified replacement

**Gate:** Founder approval uses realistic populated journeys, not isolated components or screenshot similarity.

## 13. Testing and Acceptance

Testing combines:

- Unit and component-state coverage
- Accessibility checks for semantics, keyboard use, focus, and contrast
- API contract tests
- Integration tests for campaign context, filters, permissions, and recovery
- Browser-level golden-journey tests
- Visual regression for layout, tokens, and responsive breakpoints
- Production build verification

Visual regression does not substitute for workflow acceptance.

A journey is complete only when:

- Every mapped capability in scope is accessible
- The primary goal works end to end
- Campaign context persists
- Empty, sample, loading, success, partial-success, error, blocked, and stale states are covered as applicable
- Desktop and narrow-screen behavior are verified
- Keyboard navigation and focus are correct
- Destination previews are accurate
- Approval, authorization, and automation are understandable
- Recovery preserves work where possible
- Tests and production build pass
- The populated experience receives founder approval

## 14. Product Measures

Track:

- Time to first useful approved output
- Time for a returning user to identify the next required action
- Campaign creation completion
- Review-to-authorization completion
- Authorization-to-execution completion
- Percentage of mapped capabilities reachable through normal journeys
- Dead-end navigation and abandoned flows
- Integration and execution recovery rates
- Use of Home, Calendar, and Review
- Understanding and use of "Why Tuezday made this"
- Percentage of work requiring fewer revisions over time
- Accepted learning suggestions and their downstream effect

## 15. Governance and Responsibilities

- **Product archaeology owner:** capability registry, API coverage, route migration
- **Journey owner:** information architecture, journey states, continuity, analytics
- **Brand and design-system owner:** website-derived tokens, components, accessibility, pattern governance
- **Golden-loop owner:** first end-to-end slice and shared interaction proof
- **Wave owners:** later journeys using approved patterns
- **UX QA owner:** complete journey, responsive, keyboard, loading, failure, and recovery validation
- **Engineering reviewer:** GTM contracts, context persistence, API use, permissions, and regression safety

Agents implement approved journeys and patterns. They do not independently create local design systems or silently change product terminology.

## 16. Risks and Controls

| Risk | Control |
|---|---|
| A Blaze clone obscures Tuezday's moat | Use Blaze for interaction clarity and Tuezday for model, brand, evidence, governance, and channel breadth. |
| Capability loss during simplification | Require registry coverage and migration treatment before implementation. |
| Overloaded campaign workspace | Preserve focused tabs and global cross-campaign views. |
| Status fragmentation | Govern one canonical dictionary and shared components. |
| Conversational editing hides precise controls | Retain focused direct-edit tools and destination previews. |
| Spectrum colors conflict with state | Separate brand/category colors from semantic workflow colors. |
| Sample content misleads users | Label sample data and provide an explicit transition to live data. |
| Mobile scope delays the revamp | Prioritize triage and authorization; define honest desktop boundaries for dense workflows. |
| Design-system work becomes an indefinite precondition | Build only the patterns required by the golden loop, then extend by journey wave. |
| Screenshot fidelity substitutes for usability | Gate on end-to-end behavior, populated states, accessibility, and recovery. |

## 17. Explicit Non-Goals

- Replacing the GTM domain model
- Exposing every backend entity in navigation
- Matching Blaze branding, assets, or trade dress
- Making weekly campaigns mandatory
- Rebuilding every existing route in parallel
- Delivering full desktop-equivalent mobile planning in the first release
- Introducing persistent credits or upgrade UI without a product requirement
- Treating visual polish as proof of journey completeness

## 18. Implementation Planning Boundary

The implementation plan should be split into independently testable plans rather than one repository-wide mega-plan:

1. Baseline integration and experience-contract artifacts
2. Shared control-room shell and semantic UI system
3. Golden operating loop
4. Activation and first value
5. One plan per expansion wave
6. Route cutover and optimization

The first implementation plan must cover only the baseline, experience contract, and shared foundations needed to begin the golden operating loop. Later plans must reuse its exact tokens, status names, interfaces, and acceptance criteria.
