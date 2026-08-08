# Tuezday UI/UX Revamp Guidelines

> Status: living product and design guideline  
> Date: 2026-07-12  
> Reference product: [Blaze.ai](https://www.blaze.ai/)  
> Visual concept: [Tuezday dashboard reel concept](../tuezday-dashboard-reel-concept.png)

## 1. Purpose

Tuezday has a broad, interconnected GTM feature set, but the current interface presents much of it as separate modules and pages. The redesign must make the platform feel like one coherent modern SaaS product without changing the underlying product architecture or rewriting how its features function.

The GTM Orchestration Foundation remains the functional model. The UI/UX revamp will expose that model through recognizable user journeys, consistent interaction patterns, clear feature placement, and a polished visual system.

The initial direction is **Blaze-first and Tuezday-complete**:

- Use Blaze as the default reference for layout, navigation, interaction, workflow, density, and visual grammar.
- Map every Tuezday capability before rebuilding screens.
- Extend Blaze patterns when Tuezday has additional capabilities.
- Invent a new surface only when no Blaze equivalent exists.
- Preserve Tuezday's identity, terminology, assets, code, and differentiated product capabilities.

This is not a page-by-page reskin. It is a reconstruction of the product experience around complete user journeys.

## 2. Confirmed Product Decisions

1. The redesign does not replace Tuezday's backend or GTM architecture.
2. Campaigns are the primary context connecting planning, content, approvals, channels, calendar, execution, outcomes, and learning.
3. Campaign-first does not mean campaign-only. Workspace-wide foundations and global operating views remain available.
4. Home becomes a cross-campaign control room showing what needs attention now.
5. Blaze is the primary UI/UX reference for the first major redesign pass.
6. Tuezday-only features must be mapped before implementation rather than bolted onto a completed Blaze clone.
7. Agents implement approved journeys and shared patterns; they do not independently invent page-level design systems.

## 3. Non-Goals

The UI/UX revamp will not:

- Redesign the canonical GTM domain model.
- Replace the GTM Orchestration Foundation.
- Rename backend concepts merely to match Blaze.
- Expose every backend entity as a navigation destination.
- Give every existing route permanent status in the new information architecture.
- Rebuild all screens simultaneously.
- Treat visual polish as a substitute for journey design.
- Copy Blaze branding, proprietary assets, source code, or distinctive trade dress.

Existing routes may remain temporarily for compatibility while their capabilities are presented in more appropriate contexts.

## 4. Why Earlier UI Revamps Did Not Solve the Problem

Previous work improved individual screens and components, but the platform still feels fragmented because:

- Screens were treated as modules rather than stages in a user journey.
- Features sharing the same campaign, audience, content, or action context were presented separately.
- Backend and sprint terminology leaked into navigation and interface copy.
- Some implemented features were buried, partially exposed, or missing from navigation.
- Agents could make locally reasonable choices without a canonical journey or pattern library.
- Empty, loading, error, and completion states were not always designed as part of the workflow.
- Visual consistency did not guarantee that users understood what to do next.

The new process starts with capability mapping and end-to-end journeys, then uses Blaze's established UI patterns to render those journeys.

## 5. GTM Foundation Integration Baseline

Before the UI implementation begins, the GTM foundation must be integrated safely with `main`.

The `gtm-orchestration-foundation` lineage was verified with:

- 1,108 tests accounted for across the full suite.
- All GTM-specific contract and API tests passing.
- Workspace type checking passing.
- Production build passing.

It should not be merged blindly into `main`. The branch carries Sprint 41 plus six GTM foundation commits and has diverged from the current `main` lineage. A merge rehearsal identified conflict surfaces in:

- Ad Creatives
- Approvals
- Shared contracts and navigation

The safe integration sequence is:

1. Create an integration branch from current `main`.
2. Merge the GTM/Sprint 41 lineage into the integration branch.
3. Preserve the newer `main` UI when resolving visual conflicts.
4. Preserve the GTM and Sprint 41 functional contracts when resolving behavior conflicts.
5. Run the complete test suite, type checking, and production build on the merged result.
6. Merge the verified integration branch into `main`.
7. Use that merged state as the only baseline for the UI revamp.

## 6. Reference Strategy

Blaze becomes the default design authority when it has a comparable workflow.

For each feature, classify the target treatment as one of the following:

### 6.1 Direct Match

Blaze already supports an equivalent workflow. Reproduce its information hierarchy, page anatomy, interaction flow, and visual density closely, adapted to Tuezday branding and data.

### 6.2 Blaze Extension

Begin with the Blaze surface and add Tuezday's additional capability without breaking the original mental model.

### 6.3 Tuezday Exclusive

Create a new surface using the same shell, components, interaction language, spacing, states, and navigation rules established by the Blaze-derived system.

The classification applies to product behavior, not merely to route names.

## 7. Capability-to-Surface Map

Blaze's documented workspace structure includes Home, Calendar, Approvals, Campaigns, Meta Ads, Insights, Brand Kit, Content Preferences, Integrations, and a collapsible Files & Projects area. See [Navigating your Workspace](https://help.blaze.ai/en/articles/9545333-navigating-your-workspace) and [Getting Started with Blaze](https://help.blaze.ai/en/articles/9535151-getting-started-with-blaze).

| Blaze surface | Tuezday placement | Treatment |
|---|---|---|
| Home | Cross-campaign control room | Direct match with deeper operational context |
| Calendar | Global planned, scheduled, and published work | Direct match extended with campaign commitments and channel filters |
| Approvals | Content review and external-action authorization | Blaze extension |
| Campaigns | Plans, lanes, work, automation, channels, and outcomes | Major Blaze extension |
| Meta Ads | Creative, approval, launch, spend control, and reporting | Blaze extension |
| Insights | Organic, paid, outbound, campaign, and learning performance | Blaze extension |
| Brand Kit | Brain, brand profile, voice, personas, visual system, and evidence | Major Blaze extension |
| Content Preferences | Channel guidance, format preferences, generation rules, and defaults | Blaze extension |
| Integrations | Publishing accounts, CRM, advertising, and other providers | Direct match with a broader provider set |
| Files & Projects | Generated content, campaign work, media, recent items, and search | Direct match |
| Create New | Posts, carousels, ads, email, PR, and outreach generation | Blaze extension |

### 7.1 Required Feature Registry

Before screen implementation, maintain a canonical registry containing:

| Field | Purpose |
|---|---|
| Feature | User-recognizable capability |
| Existing API | Backend support and endpoint ownership |
| Existing route | Current UI exposure, if any |
| Blaze equivalent | Reference screen or flow |
| Target surface | Final UI location |
| Treatment | Direct match, extension, or exclusive |
| Journey | End-to-end workflow containing the feature |
| Required states | Empty, loading, partial, success, error, and blocked states |
| Migration treatment | Retain, redirect, embed, or retire old route |
| Visibility | Global, campaign, contextual, settings, or advanced |

No capability is considered represented merely because an API or route exists.

## 8. Placement of Tuezday-Only Capabilities

### 8.1 Discover

Discover is a new top-level Tuezday surface because Blaze does not provide an equivalent market-signal and opportunity-routing system.

It contains:

- Signal feed
- Connected and public sources
- Suggested campaign and persona matches
- Relevance explanations
- Accept, dismiss, save, and route actions
- Create-work-from-signal actions
- Source health and discovery errors

An accepted signal enters one or more campaigns. The user should be able to choose campaign, persona, channel, and output without navigating through unrelated modules.

### 8.2 Audience

Audience is a new top-level reusable resource surface containing:

- Leads
- CRM contacts
- Lists
- Dynamic segments
- CRM synchronization
- Persona-to-account assignments
- Media contacts

Resources remain global and reusable. Campaign-specific execution references these resources.

### 8.3 Outbound and PR

Outbound and PR appear in two contexts:

- Globally under Audience for managing recipients, sequences, contacts, and reusable resources.
- Inside a campaign under Channels for campaign-specific configuration, work, and outcomes.

This is deliberate dual placement: resources are global; execution is campaign-specific.

### 8.4 Engagement Inbox

Approvals answers, “What must I authorize?”

Inbox answers, “Who responded, and what should I do?”

They should share:

- Item-detail drawer
- Content and channel previews
- Campaign context
- Status language
- Action placement
- Assignment and collaboration behavior

Inbox may be a sibling top-level item or a sibling tab within a shared Review area. The final choice will be made during shell design.

### 8.5 Brain, Evidence, and Context

Blaze's Brand Kit is the closest reference model. Tuezday extends it with deeper context and evidence.

Target sections:

- Brand Profile
- Voice
- Personas
- Visual Style
- Source Materials
- Evidence
- Content Guidance
- Advanced Context

The resolver should not remain a normal primary module. Every generated output exposes a friendly “Why Tuezday made this” disclosure showing the relevant Brain, evidence, persona, campaign, and guidance inputs. The complete inspector remains available under Advanced Context.

### 8.6 Campaign Plans and Lanes

Plans, revisions, and lanes are implementation concepts presented through user language.

The campaign experience exposes:

- Goals and strategy
- Audiences
- Channels and output volume
- Schedule
- Supporting context
- Automation and approval policy
- Work produced
- Results

Plan revisions become **Plan history**. Lanes become rows or cards under **Channels**.

### 8.7 Automation, Cadence, and Autonomy

- Cadence lives under Campaign Schedule.
- Campaign automation lives under Campaign Automation.
- Workspace generation defaults live under Content Preferences.
- Global safety rules live under Workspace Settings.
- Every publish, send, reply, launch, budget, or targeting action explains whether authorization is required.

These capabilities should not remain disconnected primary modules.

### 8.8 Learning

Learning is presented through Insights and Review rather than as a machine-room destination.

- Insights explains what Tuezday learned from performance.
- Review presents suggested Brain or guidance updates.
- Accepted changes link to their evidence and affected campaigns.
- Advanced history remains available without occupying primary navigation.

### 8.9 Notifications

Notifications live under:

`Workspace menu → Settings → Notifications`

This includes approval alerts, publishing results, execution failures, email, and Telegram configuration.

### 8.10 Developer Capabilities

Technical capabilities live under:

`Workspace Settings → Developer`

This contains:

- API keys
- MCP setup
- Webhooks
- Event log
- Audit activity

They remain accessible without competing with everyday marketing workflows.

## 9. Proposed Navigation Model

The first navigation proposal preserves Blaze's mental model and adds only the Tuezday surfaces that cannot fit cleanly inside it.

### Primary Operating Area

- Home
- Calendar
- Approvals
- Inbox
- Campaigns
- Discover
- Audience
- Ads
- Insights

### Foundations

- Brain
- Content Preferences
- Integrations

### Files and Work

- Create New
- Search
- Recent
- Projects
- Media Library

### Workspace Menu

- Team
- Billing
- Notifications
- Developer
- Activity
- Workspace Settings

Discover and Audience are the two primary Tuezday additions to the Blaze navigation model. Other differentiated capabilities should extend existing surfaces wherever possible.

## 10. Campaign-First Without Becoming Campaign-Only

Campaign-first creates a coherent operating context, but it must not trap every capability inside a campaign.

### Workspace Foundations

The following remain workspace-level:

- Brain and brand system
- Integrations
- Team and billing
- Global content preferences
- Global safety and autonomy defaults
- Reusable audiences, evidence, media, and connections

### Global Operating Views

The following remain cross-campaign:

- Home
- Calendar
- Approvals
- Inbox
- Discover
- Insights

### Campaign Views

The same work can be entered in campaign context with campaign filters already applied.

A campaign should behave like a focused workspace with:

- Overview
- Plan
- Work
- Calendar
- Approvals
- Channels
- Results

It must not become one enormous page.

### Always-On and One-Off Work

- Always-on work belongs to visible evergreen campaigns.
- Manual one-off creation may begin outside a campaign.
- Scheduling, publishing, sending, or launching requires a campaign selection or campaign creation.

## 11. Golden User Journeys

Screens are designed and accepted as parts of these journeys, not as isolated modules.

### 11.1 New Workspace Setup

`Website → Brand/Brain → Persona → Integrations → First campaign`

Success means a new user reaches meaningful generated work without understanding Tuezday's internal architecture.

### 11.2 Create and Configure a Campaign

`Goal → Audience → Channels → Schedule → Context → Automation → Review summary → Activate`

The flow uses sensible defaults, progressive disclosure, and a final plain-language summary.

### 11.3 Daily Control Room

`Open Home → Identify priority → Understand blocker → Take action → See next action`

The returning user should find useful work within five seconds.

### 11.4 Review and Publish

`Open item → Preview as destination sees it → Edit or regenerate → Approve → Schedule or publish → Confirm result`

Content approval and permission for external action must remain understandable even when governed separately.

### 11.5 Discover and Respond

`Review signal → Understand relevance → Select campaign and persona → Create channel work → Enter review flow`

The user should not manually reconstruct context already known to the system.

### 11.6 Evaluate and Improve

`Open campaign results → Compare channels and work → Understand outcomes → Review suggested learning → Apply approved change`

Metrics must lead to a decision or action, not exist as decorative dashboards.

### 11.7 Operate Differentiated Channels

Outbound, PR, paid ads, evidence, context inspection, and governance extend the journeys above. They do not become unrelated product islands.

## 12. Journey Definition Standard

Every approved journey documents:

- User goal
- Entry points
- Required context
- Primary action
- Secondary actions
- Decision points
- Empty state
- Loading and generation state
- Partial-success state
- Recoverable and blocking errors
- Completion state
- Natural next action
- Cross-links into adjacent journeys
- Mobile or narrow-screen behavior
- Analytics events needed to evaluate the journey

## 13. Cross-Campaign Home

Home is an attention and decision surface, not a collection of module cards.

It should answer:

1. What needs my attention?
2. What is happening today?
3. What is blocked or at risk?
4. What is scheduled next?
5. What is performing?
6. What should I do now?

Candidate sections include:

- Approvals and authorizations waiting
- Campaign momentum
- Upcoming planned and scheduled work
- New high-value signals
- Execution failures or missing connections
- Recent outcomes
- Suggested learning or Brain updates
- One prioritized next action

The dashboard concept image linked at the top of this document is a marketing-oriented visualization of this direction, not an approved production specification.

## 14. Blaze UI Grammar to Document

The reference audit must capture concrete patterns rather than relying on “make it look like Blaze.”

Document:

- App-shell dimensions and responsive behavior
- Sidebar hierarchy, sections, badges, and collapse behavior
- Top bar and workspace switcher
- Typography family, scale, weight, and line height
- Spacing and density
- Page headers and primary actions
- Tables, cards, lists, galleries, and calendars
- Tabs, filters, search, sorting, and saved views
- Modals, drawers, popovers, and full-page workflows
- Creation wizards
- Content preview and editing patterns
- Batch selection and actions
- Empty, loading, generating, success, warning, and error states
- Status colors and semantic badges
- Toasts, progress indicators, and background-job feedback
- Hover, focus, selected, disabled, and destructive states
- Motion timing and reduced-motion behavior

Blaze's calendar supports multiple views, filtering, previewing, selection, regeneration, and scheduling within one operating surface. See [Managing Your Content](https://help.blaze.ai/en/articles/12492103-managing-your-content) and [Content Calendar Overview](https://help.blaze.ai/en/articles/10548412-content-calendar-overview).

## 15. Visual Direction

The production interface should feel:

- Modern and premium
- Calm rather than noisy
- Operational rather than decorative
- Content-forward
- Dense enough for serious work without becoming intimidating
- Consistent across simple and advanced capabilities
- Recognizably Tuezday even where Blaze supplies the interaction pattern

The initial dashboard concept uses:

- Warm white surfaces
- Deep ink typography
- Indigo-violet primary accents
- Coral attention accents
- Emerald success states
- Muted slate secondary text
- Soft one-pixel borders
- Medium corner radii
- Restrained shadows

These colors and treatments are exploratory until the visual reference audit and shell design are approved.

## 16. UX Rules

1. Every screen must make its purpose and primary action clear without a tour.
2. Every state must answer what happens next.
3. AI is described by the outcome it creates, not by internal mechanisms.
4. Advanced machinery remains inspectable but is not the default front door.
5. Settings inherit from workspace defaults and visibly indicate overrides.
6. Campaign context persists across navigation, filters, and deep links.
7. Global views and campaign-filtered views use the same underlying interaction patterns.
8. Generated content is previewed as the destination will display it.
9. External actions clearly display authorization and automation status.
10. Metrics lead to actions, explanations, or decisions.
11. Forms with many decisions use progressive disclosure or stepped workflows.
12. Empty states explain future value and provide the first useful action.
13. Partial success is represented honestly; one channel failure must not obscure successful work elsewhere.
14. Background work exposes progress and allows the user to continue using the platform.
15. Destructive and spend-affecting actions require clear confirmation and consequences.

## 17. Error and Recovery Design

Error handling is part of each journey.

The interface must distinguish:

- Missing setup, such as an unconnected account
- Invalid user input
- Insufficient campaign context
- Authorization required
- Temporary provider failure
- Partial multi-channel failure
- Plan or entitlement limitation
- Stale work caused by campaign-plan changes
- Execution blocked by campaign status or safety policy

Each error should provide:

- Plain-language cause
- Scope of impact
- Work preserved
- Recommended recovery
- Retry action when safe
- Link to the relevant setting when configuration is missing

Technical traces belong in expandable details or developer surfaces.

## 18. Implementation Sequence

### Phase 0: Integrate the Functional Baseline

Reconcile and verify GTM/Sprint 41 with `main`.

### Phase 1: Build the Capability Registry

Map every backend capability, current route, Blaze equivalent, target surface, and journey.

### Phase 2: Build the Blaze Reference Pack

Collect screenshots, recordings, measurements, and interaction notes for core Blaze workflows.

### Phase 3: Approve Journey Maps

Approve the golden journeys and their state diagrams before visual implementation.

### Phase 4: Approve the UX Skeleton

Define low-fidelity structure for:

- Global shell
- Home
- Campaign workspace
- Campaign creation
- Calendar
- Approval and preview
- Brain and brand setup
- Search and recent work
- Settings and integrations

### Phase 5: Establish the Shared UI System

Implement approved tokens, primitives, navigation, drawers, modals, previews, tables, calendars, forms, and feedback states.

### Phase 6: Complete One Golden Vertical Slice

The first implementation slice is:

`Home → Campaign → Content item → Approval → Calendar`

It proves the shell, context persistence, previews, status language, filters, drawers, and next-action logic.

### Phase 7: Expand by Journey Wave

1. Campaign planning and orchestration
2. Content, approvals, and calendar
3. Discovery and reactive creation
4. Brain, brand, evidence, and context
5. Audience, outbound, and PR
6. Ads and insights
7. Settings, integrations, team, billing, notifications, and developer tools

Do not redesign all current routes in parallel.

## 19. Agent Responsibilities

### Product Archaeology Owner

- Owns the capability registry.
- Verifies API and route coverage.
- Prevents hidden features from disappearing during simplification.

### UX Journey Owner

- Owns journey maps, information architecture, state design, and navigation continuity.
- Ensures screens make sense as a sequence.

### Blaze Reference Owner

- Owns the reference library and pattern measurements.
- Distinguishes reusable patterns from Blaze-specific branding.

### Design-System Owner

- Owns tokens, components, interaction states, accessibility, and pattern governance.
- Approves new shared patterns before they spread.

### Golden-Slice Implementer

- Implements the first approved end-to-end journey.
- Does not redesign unrelated modules.

### Feature-Wave Implementers

- Migrate later journeys using the established system.
- Escalate missing patterns rather than inventing local alternatives.

### UX QA Owner

- Tests complete journeys and capability visibility.
- Validates responsive behavior, keyboard access, loading, errors, and recovery.
- Does not limit acceptance to screenshot comparison.

### Engineering Reviewer

- Protects GTM contracts and data behavior.
- Reviews context persistence, API use, error handling, and regression coverage.

## 20. Founder Involvement

Founder time should be concentrated on decisions that agents cannot infer reliably:

- Provide authenticated Blaze screenshots or recordings for the flows worth copying.
- Approve golden journeys.
- Decide what users should notice first on important screens.
- Choose information density and visual tone.
- Review realistic populated states rather than empty mockups alone.
- Test whether a user can complete work without understanding Tuezday's internals.
- Approve the golden vertical slice before patterns spread.

Recommended review cadence:

- **Journey review:** Does the flow match how the product should be used?
- **Visual review:** Does it feel sufficiently close to Blaze and sufficiently like Tuezday?

Two structured reviews per week are preferable to continuous unstructured feedback.

## 21. Acceptance Standard

A redesigned journey is complete only when:

- Every mapped capability in its scope is accessible.
- The primary user goal can be completed end to end.
- Campaign context and filters remain consistent.
- Empty, loading, success, partial-success, error, and blocked states are implemented.
- Desktop and narrow-screen behavior are verified.
- Keyboard navigation and visible focus states work.
- Content previews represent destination output accurately.
- Authorization and automation state are understandable.
- Relevant unit, integration, and journey tests pass.
- The production build passes.
- The founder approves the populated experience, not merely the component styling.

## 22. Measures of Success

The revamp should improve observable product behavior:

- Time for a new user to reach first useful output
- Time for a returning user to identify the next required action
- Campaign-creation completion rate
- Approval-to-publish completion rate
- Percentage of implemented capabilities reachable through normal journeys
- Reduction in dead-end navigation and abandoned forms
- Recovery rate from integration and execution errors
- Use of cross-campaign Home, Calendar, and Review surfaces
- User understanding of why an output was created and what will happen next

## 23. Design Decisions Still to Resolve

These decisions are intentionally reserved for the next design sessions:

1. Whether Inbox is a primary item or a sibling tab inside Review.
2. Exact sidebar grouping and collapse behavior.
3. Exact Blaze visual fidelity versus Tuezday visual differentiation.
4. Campaign workspace tab labels and hierarchy.
5. Global versus campaign-local placement of Create New.
6. Desktop density and minimum supported viewport.
7. Mobile scope: full operation, approval-focused companion, or responsive subset.
8. Final typography, palette, radius, shadow, and motion tokens.
9. Search scope and command-palette behavior.
10. Route migration and redirect strategy.

These are design questions, not permission to leave implementation behavior ambiguous. Each must be resolved in the relevant journey or shell specification before that part is built.

## 24. Related Repository Documents

- [`docs/research/ui-audit.md`](research/ui-audit.md)
- [`docs/specs/sprint-18-dashboard-redesign.md`](specs/sprint-18-dashboard-redesign.md)
- [`docs/specs/sprint-33-dashboard-redesign-v2.md`](specs/sprint-33-dashboard-redesign-v2.md)
- [`docs/superpowers/specs/2026-07-03-ui-polish-design.md`](superpowers/specs/2026-07-03-ui-polish-design.md)
- [`docs/superpowers/specs/2026-07-11-gtm-orchestration-control-plane-design.md`](superpowers/specs/2026-07-11-gtm-orchestration-control-plane-design.md)

This guideline supersedes earlier documents only where they conflict with the confirmed Blaze-first, capability-mapped, journey-led direction. Earlier documents remain useful implementation history and research evidence.
