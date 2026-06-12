# Competitive Research — UI/UX Audit & Dashboard Redesign Recommendations

> Date: 2026-06-11
> Companion to `product-feature-opportunities.md`. Same five platforms: HubSpot, Jasper, Clay, Smartlead, Hootsuite.
> Question: how should Tuezday's dashboard be redesigned so a user with zero context understands it — based on how these platforms present their functionality?
> Feeds Sprint 18 (Dashboard UX Redesign). Visual direction still pending the founder's design-reference link; everything here is information architecture, naming, and onboarding — independent of visual style.

---

## 1. Tuezday's current problem, stated plainly

Tuezday's navigation today speaks the *build plan's* language, not the user's: Brain, Resolver, Signals, Sandbox, Approval queue, Connectors, Synthesis. A founder who built it parses this instantly; a new marketer cannot answer "where do I make a LinkedIn post?" without a tour. The research below shows this exact failure killing adoption at Clay, and the opposite pattern (activity-named, outcome-described modules) working at Jasper and Hootsuite.

---

## 2. What each platform teaches

### Jasper — the model to copy most
- Small, flat sidebar: documents, Apps (templates), Brand Voice, campaigns — "everything built around speed and reuse." Reviewers consistently call it usable "even for those who aren't tech-savvy" ([Fritz.ai](https://fritz.ai/jasper-ai-review/), [TheCMO](https://thecmo.com/tools/jasper-ai-review/)).
- Onboarding is a ~2.5-minute, ~20-screen flow (profile, industry, workspace name) followed by a **welcome tour + onboarding-steps checklist** before the dashboard ([PageFlows recording](https://pageflows.com/post/desktop-web/onboarding/jasper/)). Brand-voice training (~20 min, upload writing samples + describe tone) happens as guided setup, and reviewers single it out as the moment the product "starts sounding like you."
- **Lesson:** the brain-equivalent (Brand Voice/IQ) is presented as a *setup step with a clear payoff*, not as architecture. Tuezday's five-doc brain fill-in should be framed the same way: "Teach Tuezday your company" with a progress meter, not five empty markdown editors.

### HubSpot — grouping at scale (and its cost)
- Navigation = top bar + collapsible left sidebar grouped into plain categories: **CRM, Marketing, Content, Commerce, Automation, Reporting & Data, Library** ([HubSpot nav guide](https://knowledge.hubspot.com/help-and-resources/a-guide-to-hubspots-navigation)). Users can bookmark up to ten frequent items.
- Reception is mixed — smoother for frequent tabs, but the sidebar eats space and admins can't hide unused tools, so small teams see enterprise sprawl ([community thread](https://community.hubspot.com/t5/HubSpot-Ideas/More-control-over-Navigation-UI-and-Default-Property-Labels/idi-p/984341)).
- AI is presented as **named teammates with job descriptions in outcome language**: "Prospecting Agent — monitor buying signals and launch personalized outreach automatically" ([Breeze page](https://www.hubspot.com/products/artificial-intelligence)). Never mechanism, always outcome.
- **Lesson:** group nav by job-to-be-done category; describe AI by what it does *for* the user; and don't show modules the workspace doesn't use yet.

### Clay — the cautionary tale
- The spreadsheet UI "looks simple but hides real complexity"; learning curve 4–6 weeks; 28% of negative reviews cite it; "built for GTM engineers — sales teams without technical support abandon within 60 days" ([SyncGTM](https://www.syncgtm.com/blog/clay-review), [G2](https://www.g2.com/products/clay-com-clay/reviews)).
- Clay's own mitigation is **Sculptor** — describe what you want in natural language, it builds the workflow — i.e., they're papering over machinery exposure with an AI concierge.
- **Lesson:** exposing the machinery is the failure mode, even when the machinery is the moat. Tuezday's resolver/trace/overlays are its Clay-tables — power users must reach them, but they must never be the front door. Default surfaces show outcomes; machinery sits behind a "why this output?" disclosure.

### Smartlead — functional naming, dense panels
- Left nav named after objects users already know: **Email Campaigns, Master Inbox, Email Accounts, CRM, Integrations, Analytics** ([help center](https://helpcenter.smartlead.ai/en/articles/100-main-dashboard-analytics-explanation)). The campaign list is a metric table (sent/opened/replied/positive replies) with filters — operational and scannable.
- But reviews call the interface "clunky in places… settings that should be one click away take several," and campaign setup spans "multiple screens with dense option panels," costing new users 1–2 weeks ([Sparkle](https://sparkle.io/blog/smartlead-review/), [Built for B2B](https://www.builtforb2b.com/blog/smartlead-review-2026-cold-email-infrastructure-tested)).
- **Lesson:** plain nav nouns work; dense settings panels don't. Any Tuezday flow with >5 options becomes a stepped wizard with defaults.

### Hootsuite — activity-named modules, clutter warning
- Module names are the cleanest in the study: **Planner** (schedule), **Inbox** (respond), **Listening** (monitor), **Analytics** (measure), **Create** (make) — verbs/activities a non-marketer understands on sight ([platform page](https://www.hootsuite.com/platform)).
- Yet the dashboard "can feel cluttered and dated — easy for new teammates to get lost in streams, tabs, and settings" ([Planable](https://planable.io/blog/hootsuite-alternatives/)). AI-generated posts route through the same approval workflows as human posts — AI output is never exempt from review ([OwlyWriter](https://www.hootsuite.com/platform/owly-writer-ai)).
- **Lesson:** name modules after activities; route AI output through the normal review surface (Tuezday already does — keep it one unified queue); cap surface count per screen.

---

## 3. Recommendations for Tuezday

### 3.1 Navigation: rename to the GTM activity, keep ≤ 8 items

Proposed left nav, ordered as the GTM loop the product actually implements:

| # | Proposed label | One-line description (shown under page header) | Today's surface |
|---|---|---|---|
| 1 | **Home** | What needs your attention today | (new — see 3.4) |
| 2 | **Brain** | Everything Tuezday knows about your company — edit it anytime | Brain docs + personas + evidence |
| 3 | **Discover** | What's happening in your market right now | Signal inbox + sources |
| 4 | **Create** | Generate posts, emails, and ads in your voice | Sandbox + content drafts |
| 5 | **Review** | Approve, edit, or reject before anything goes out | Approval queue + decision log |
| 6 | **Campaigns** | Your GTM goals and everything attached to them | Campaigns (+ later: calendar, ads reporting) |
| 7 | **Audience** | Leads, contacts, and your CRM | Outbound leads + CRM |
| 8 | **Settings** | Workspace, integrations, team | Connectors + workspace config |

Naming rationale:
- **Keep "Brain."** It's the moat and it's self-explanatory *with a subtitle*. Jasper brands its equivalent (IQ) and it works. Don't genericize the one differentiated concept.
- **"Discover" not "Signals"**, **"Review" not "Approval queue"**, **"Settings → Integrations" not "Connectors," "Nango," or "fabric."** Infrastructure words never appear in nav (HubSpot never says "workflow engine"; Hootsuite never says "stream adapter").
- **Resolver/trace moves out of nav entirely.** It becomes a **"Why this output?"** expandable panel on every generated draft (showing the resolved bundle + trace) and a "Context inspector" reachable from Brain for power users. This is the Clay lesson applied: the inspectability moat stays one click deep, not on the front door.
- Learning-loop synthesis proposals surface in **Review** (they're approvals) and **Home**, not as their own nav item.

### 3.2 Page anatomy: header pattern everywhere
Every page gets: plain-language title → one-line "what this is for" → primary action button. No page may assume the user arrived knowing what it does. This is the cheapest fix in the whole redesign and addresses the founder's core complaint directly ("the header should be something a normal user without context can understand").

### 3.3 Empty states do the onboarding
Every list/queue empty state states what will appear there and offers the first action ("No signals yet — connect a source or paste one manually → [Add source]"). Jasper and HubSpot both lean on this; Tuezday currently has raw empty tables.

### 3.4 First-run: guided checklist, Jasper-style
New workspace lands on **Home** with a 4-step setup checklist and progress meter:
1. **Teach Tuezday your company** → guided brain fill-in (one doc at a time, with prompts/examples — not five blank editors), completeness score as the progress meter (already built in Sprint 2, just re-surfaced).
2. **Add a voice** → create one persona.
3. **Generate your first draft** → one-click guided generation showing "here's what Tuezday used" (friendly trace).
4. **Approve it** → lands in Review, user approves, sees the loop close.

This converts Tuezday's actual dependency chain (brain → persona → generate → approve) into the onboarding, and it mirrors the structure reviewers praise at Jasper.

### 3.5 Home dashboard: attention, not architecture
Home shows queues and outcomes, not module tiles: drafts waiting for review (count + jump-in), new signals worth a look, active campaign snapshot, latest published/exported items, and pending `now` synthesis proposals. The Smartlead campaign table is the model for scannability; the metric is "can a returning user act within 5 seconds."

### 3.6 Present the AI in outcome language
Wherever generation appears, describe it like Breeze/OwlyWriter do: "Drafts a LinkedIn post in your voice, using what's in your Brain" — never "resolves context through overlay layers." The trace stays available behind "Why this output?" — inspectability as *trust feature* ("see exactly what Tuezday used"), which none of the five competitors offer. Frame it as a selling point in the UI copy.

### 3.7 Anti-patterns to actively avoid (each observed in the wild)
- **Clay:** machinery as front door → 60-day abandonment. Resolver/overlays stay behind disclosures.
- **Hootsuite:** unbounded tabs/streams clutter → cap each page at one primary surface + one side panel.
- **HubSpot:** showing every module to every user → hide nav items for modules the workspace hasn't enabled (no ads nav before an ad account exists).
- **Smartlead:** dense option panels → any form >5 fields becomes a stepped wizard with sensible defaults.

### 3.8 Calendar (forward-looking)
When Sprint 17 introduces scheduled posts, add a calendar view under Campaigns (HubSpot marketing calendar / Hootsuite Planner pattern: assets on dates, actionable in place). Design the Campaigns layout in Sprint 18 with a tab slot reserved for it so it isn't a bolt-on.

---

## 4. How this maps to Sprint 18

Sprint 18's plan already specifies an IA pass → layout system → visual design → first-run path. This audit fills in the IA pass (§3.1–3.2), empty states (§3.3), first-run (§3.4–3.5), and copy guidelines (§3.6). Remaining open input: **the founder's design-reference website** governs §"visual design" only — typography, spacing, color, component feel. Nothing in this document blocks on it, and none of it should be redone when the link arrives.

---

## Sources

- [Jasper platform](https://www.jasper.ai/platform) · [Jasper onboarding flow (PageFlows)](https://pageflows.com/post/desktop-web/onboarding/jasper/) · [Jasper UI screens (NicelyDone)](https://nicelydone.club/apps/jasper) · [Jasper review (Fritz.ai)](https://fritz.ai/jasper-ai-review/) · [Jasper review (TheCMO)](https://thecmo.com/tools/jasper-ai-review/) · [Jasper review (Amrytt)](https://amrytt.com/jasper-ai-review/)
- [HubSpot navigation guide](https://knowledge.hubspot.com/help-and-resources/a-guide-to-hubspots-navigation) · [Nav customization community thread](https://community.hubspot.com/t5/HubSpot-Ideas/More-control-over-Navigation-UI-and-Default-Property-Labels/idi-p/984341) · [Nav changes analysis (NgageContent)](https://ngagecontent.com/hubspot-practices/new-changes-to-hubspot-navigation/) · [Breeze AI page](https://www.hubspot.com/products/artificial-intelligence)
- [Clay review (SyncGTM)](https://www.syncgtm.com/blog/clay-review) · [Clay reviews (G2)](https://www.g2.com/products/clay-com-clay/reviews) · [Clay review (Artisan)](https://www.artisan.co/blog/clay-review) · [Clay homepage](https://www.clay.com/)
- [Smartlead dashboard docs](https://helpcenter.smartlead.ai/en/articles/100-main-dashboard-analytics-explanation) · [Smartlead review (Sparkle)](https://sparkle.io/blog/smartlead-review/) · [Smartlead review (Built for B2B)](https://www.builtforb2b.com/blog/smartlead-review-2026-cold-email-infrastructure-tested)
- [Hootsuite platform](https://www.hootsuite.com/platform) · [OwlyWriter AI](https://www.hootsuite.com/platform/owly-writer-ai) · [Hootsuite alternatives/UX critique (Planable)](https://planable.io/blog/hootsuite-alternatives/) · [April 2026 features](https://blog.hootsuite.com/new-features-apr-2026/)
