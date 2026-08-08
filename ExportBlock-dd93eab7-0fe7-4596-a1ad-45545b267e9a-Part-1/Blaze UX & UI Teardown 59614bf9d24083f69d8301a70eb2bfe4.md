# Blaze UX & UI Teardown

# Blaze — Interface & Experience Teardown

> **Purpose:** A screen-by-screen map of Blaze’s UI, navigation, content model, microcopy, badge language and activation nudges — captured live from a working workspace as a reference for building **Tuezday’s** equivalent experience.
> 

**Captured:** Jul 12, 2026 · **Workspace:** app.blaze.ai/1026204 · **Coverage:** 14 screens + 2 creation wizards · **Tagline:** “AI that does marketing for you”

---

## Contents

- 1. The product model
- 2. The global shell
- 3. Design system
- 4. Status & badge language
- 5. Nudges & growth mechanics
- 6. Screens
- 7. Create wizards
- 8. User journeys
- 9. Clone checklist
- 10. Scope & gaps

---

## 1. The product model

Blaze is **not a design tool you drive** — it is an agent that plans, writes, designs and (once accounts are connected) publishes marketing on a weekly cadence. The user’s job is to **set direction and approve**, not to produce. Every screen is organized around that loop.

### The core content hierarchy

Almost every object in the app is a node in one three-level tree. It explains the whole navigation and both creation wizards.

**Strategy → Campaign → Post**

| Level | What it is |
| --- | --- |
| **Strategy** | A group of campaigns around a goal (e.g. “Lifestyle Content — day-in-the-life moments”). The reusable brief. |
| **Campaign** | A themed set of posts over a date range — always one week (Jul 10–16). Has a Theme + Call-to-action. |
| **Post** | A single asset (Still Image, Carousel, Blog Post, Email, Video) scheduled to a time, added to a campaign. |

### The four pillars the UI keeps returning to

1. **Generate** — AI drafts posts from the campaign brief + Brand Kit. Costs **credits** (workspace currency, shown top-right with a ✦).
2. **Approve** — Nothing publishes without a human OK. Unapproved posts wear a `🟡 Review ⚠` badge everywhere they appear.
3. **Publish** — Once social accounts are connected, approved posts auto-publish on schedule via the Calendar.
4. **Learn** — Performance feeds back into Learnings & Insights, so “marketing gets smarter every week.”

> 💡 **The demo content itself is the sales pitch.** Every generated post is about “approval-driven GTM,” “campaign memory,” and “nothing ships without your OK.” Blaze **seeds a new workspace with on-message sample campaigns** so the app never looks empty. Copy this — never show a new user an empty product.
> 

---

## 2. The global shell

A fixed **left sidebar** and a **contextual top bar** frame every screen. The sidebar is the app’s information architecture made visible; the top bar changes its action cluster per screen but always keeps Credits + Upgrade + avatar pinned right.

Home — the full shell: sidebar, contextual top bar, content column

![Home — the full shell: sidebar, contextual top bar, content column](Blaze%20UX%20&%20UI%20Teardown/98cfd352-2793-491b-b6dd-c1ea6c0ed290.jpg)

Home — the full shell: sidebar, contextual top bar, content column

### Sidebar (top → bottom)

| Region | Contents |
| --- | --- |
| **Workspace switcher** | Logo mark + workspace name + chevron → *My Workspaces / Create workspace / Sign out*. |
| **Primary nav** | Home · Calendar · Campaigns · Integrations `0/4` · Brand Kit · Content Preferences · Approvals · Learnings · Insights |
| **“Reach” group** | Collapsible. Paid + discovery: **Meta Ads**, **SEO/AEO** `Beta`. |
| **“Files & Projects”** | Create New · Search · Recents · Media Library · Archived Posts, then document folders + one folder **per weekly campaign**. |
| **Footer utilities** | Refer & Earn · Join our Community · Invite Team Members · Help & Learn Blaze. |

### Top bar

| Element | Notes |
| --- | --- |
| **Page title** | Left; matches the nav item. |
| **Contextual actions** | Per screen (e.g. Campaigns → `+ Create New`, `Settings ▾`; Calendar → date nav, view mode, filters). |
| **Credits meter** | `✦ 143 Credits` — always pinned. AI generation spends this; doubles as an upgrade hook. |
| **Upgrade** | Violet-outlined 🔒 button, pinned. The single most repeated conversion CTA. |
| **Persistent overlays** | Intercom chat bubble (proactive message from “Joe”) + a “?” help FAB, both bottom-right. |

---

## 3. Design system

Blaze’s visual language is **quiet and utilitarian**: near-white grounds, thin hairline borders, generous whitespace, monoline outline icons, and a restrained palette where **black is the primary action** and **violet is reserved for AI, credits and upgrade**. Semantic color does the heavy lifting through the badge system.

### Palette (eyedropped approximations for rebuild reference)

| Token | Hex | Use |
| --- | --- | --- |
| Primary action | `#0F0F12` | Black buttons (Create, Approve-all CTAs) |
| Accent | `#574AE2` | AI / credits / upgrade / links — violet |
| Surface | `#FFFFFF` | Cards, panels |
| Ground | `#F3F4F7` | App background (cool neutral) |
| Good | `#158A4A` | Approve / success / connected |
| Warn | `#F2B417` | Review / needs-attention |
| Info | `#1F5FD6` | Posting / active |
| Idle | `#ECECF1` | Generating / passive-future |

### Typography & form

- **Type:** a single geometric-humanist sans across the app. Large, tight-tracked headings; comfortable body; no serifs.
- **Shape:** ~12–16px corner radii on cards; pills fully rounded; buttons ~10px. Borders are 1px hairlines in a cool grey, not shadows — elevation used sparingly.
- **Icons:** consistent monoline/outline set. Meaningful glyphs: **✦ sparkle** = AI/credits, **⚠ triangle** = needs attention, **🔒 lock** = gated/upgrade.
- **Content-type glyphs:** each post format has its own colored icon + label — **Still Image · Carousel · Blog Post · Email · Video** — reused identically on cards, tables and the editor.

---

## 4. Status & badge language

State is encoded as **color + pill** everywhere, so a user can scan the Calendar, Campaigns list or Approvals and know what needs them without reading. **This is the most important system to copy faithfully** — it’s how the whole “approve” loop stays legible.

| Badge | Meaning |
| --- | --- |
| `🟡 Review ⚠` | **Needs your approval.** Amber pill + warning coin. On every unapproved post — cards, calendar, recents, editor header. |
| `🔵 Posting` | **Actively publishing** to connected accounts. On campaigns + detail. |
| `⚪ Generating on Jul 22` | **Scheduled AI generation**, not yet run. Grey = passive/future. Variant: “Generating in 2 days”. |
| `🟡 6 Accounts to Connect` | **Blocker badge.** Tells the user why publishing hasn’t happened — a nudge disguised as status. |
| `🟢 ✓ Approve All` | **Positive/commit action** — approval, success, connected states. |
| `Used` | Metadata chip on Brand Kit media that’s already appeared in content. |
| `Beta` | Feature-maturity tag (SEO/AEO). |
| `Next up →` | **Sequencing nudge** — points to the recommended next onboarding step. |

Meta Ads adds an A/B pair: **⚑ Champion** (current winner) vs **↗ Challenger** (AI-generated test variant).

---

## 5. Nudges & growth mechanics

Blaze is aggressively activation-driven. Almost every surface pushes toward one goal — **connect your social accounts** — because that unlocks publishing, Insights and Learnings. These are as much a part of the UX as the screens.

| Mechanic | How it shows up |
| --- | --- |
| **“Up next” cards** | Home’s top module is a prioritized to-do: *Connect your accounts* / *Approve your next campaign · 6 posts to review*. |
| **Progress counter** | `0/4` on the Integrations nav item + a ring on the page — unfinished-checklist pull. |
| **“Next up →”** | Sequenced connect buttons (Instagram is “Next up”, others queued 1–4) create a guided order. |
| **Effort framing** | CTAs carry cost-reducers: *“Takes around 2min”* next to “Connect your Accounts”. |
| **Social proof** | *“Brands like yours see +12% engagement lift in the first 30 days”* with peer logos. |
| **Gated previews** | Learnings / Insights / SEO show a blurred or mocked result behind a connect wall — show the value, withhold it. |
| **Credits scarcity** | The ✦ counter + **Upgrade** permanently in view; running low is the monetization trigger. |
| **Proactive chat** | Intercom auto-messages (“Hey Adiya, right now Blaze is in Demo…”) — human sales nudge. |
| **Referral + community** | Sidebar footer keeps Refer & Earn, Community, Invite Team Members always one click away. |

---

## 6. Screens

### Home · `/home`

A dashboard, not a feed. Two modules: **Up next** (prioritized actions) and **Upcoming posts** (next scheduled cards). Answers “what needs me?” and “what’s about to go out?”.

Home

![Home](Blaze%20UX%20&%20UI%20Teardown/98cfd352-2793-491b-b6dd-c1ea6c0ed290.jpg)

Home

- **Welcome back, {name}** — personalized greeting as the H1.
- **Up next** — stacked action cards: icon + title + one-line reason.
- **Upcoming posts** — card rail with *See All Content* + *+ Create New*; each card = type icon, date/time, preview image, caption + *more*, and a Review badge.

---

### Calendar · `/scheduled-posts`

The scheduling workhorse. Posts laid out by day as full preview cards. Top bar becomes a rich toolbar; a green **Review (4)** button batches everything awaiting approval.

Calendar

![Calendar](Blaze%20UX%20&%20UI%20Teardown/7e578822-d519-4e8b-8a7b-05646263d27b.jpg)

Calendar

- **Date nav:** `◂ Today ▸` + range label (Jul 13–16).
- **Toolbar:** `+` add · `⟳` refresh/regenerate · `🔧` tools · `🟢 ✓ Review (4)` · `Compact ▾` density · filter icon.
- **Post card:** type icon + label, time, preview, `🟡 Review ⚠` on unapproved. Click → Post Editor.

---

### Campaigns & campaign detail · `/campaigns`

Campaigns are the weekly unit of work. The list is a status board; the detail page is a live, inline-editable brief that also surfaces publishing failures.

Campaigns list

![Campaigns list](Blaze%20UX%20&%20UI%20Teardown/6b1c903e-a17c-44f4-9396-8eb4338699d9.jpg)

Campaigns list

Campaign detail

![Campaign detail](Blaze%20UX%20&%20UI%20Teardown/960356b8-f0f3-4881-9bf7-e771e829ba89.jpg)

Campaign detail

- **List row:** thumbnail · title · content-type (🐝 Lifestyle Content) · **Timing** (range) · **Status** badge · chevron.
- **Status column:** `🔵 Posting` · `⚪ Generating on Jul 22` · `⚪ Generating in 2 days` — the pipeline at a glance.
- **Detail hero:** full-bleed dark header, content-type pill, action icons (share/move · delete · duplicate).
- **Status strip:** *“0 of 6 posts published. 2 posts failed to publish.”* + **See Failed Posts** — errors explicit and actionable.
- **Inline editing:** *“Click any field to edit”* — Theme, CTA etc. edit in place; no separate settings screen.

---

### Post editor ★ (the crown jewel)

The single most important screen. A three-panel, **chat-driven** editor: you don’t manipulate the design directly — you tell Blaze what to change in natural language, preview across platforms, and set where/when it publishes. **Copy this interaction model closely.**

Post editor

![Post editor](Blaze%20UX%20&%20UI%20Teardown/2cd196e6-aa4d-44b3-b244-3fabcd59093c.jpg)

Post editor

| Region | Contents |
| --- | --- |
| **Top bar** | Back · post type + title · `🟡 Review ⚠` · ⋯ · `◂ Previous / Next ▸` (walk the queue) · **Don’t Post** · `🟢 Approve`. |
| **Left · AI panel** | *“Blaze can improve this post by:”* a numbered list of concrete suggestions (change photo, background, text overlay, colors, branding), then chat input *“Ask Blaze to change something…”* + attach + send. |
| **Center · preview** | Real social mockup with a **“View as”** switcher (IG / FB / LinkedIn / X / Google), carousel paging, native like/comment/save chrome, and a *“Do you like the result? 👍 👎”* feedback bar. |
| **Right · Posting on** | Editable date/time (Wed Jul 15, 9:00am ▾). |
| **Right · Posting to** | Per-platform toggles; unconnected platforms show inline **Connect ›** (nudge lives inside the workflow). |
| **Right · Campaign** | Back-link to parent campaign + content-type — hierarchy always visible. |
| **Right · Quick Edits** | *Adjust Caption · Edit Design · Replace with Media.* |

> 💡 **Interaction thesis:** editing is a conversation, approval is a queue. The user walks a stack of AI-made posts with Previous/Next, nudges each with plain language, and hits Approve. The craft burden is on Blaze; the judgment burden on the human.
> 

---

### Approvals · `/approvals`

The dedicated review queue — the human gate the whole product is built around. Posts grouped under their campaign; a single **Approve All** clears a week.

Approvals

![Approvals](Blaze%20UX%20&%20UI%20Teardown/e1b091e6-1e27-4667-91e7-e069a8d499dc.jpg)

Approvals

- **Campaign group:** collapsible header — name · Jul 10–16 · `🟢 ✓ Approve All`.
- **Post grid:** cards by content type (Email, Still Image, Carousel, Blog Post), each with time, preview, *more*, `🟡 Review ⚠`. Card → editor.

---

### Brand Kit · `/brand-kits`

The workspace’s memory of who the brand is. A left sub-nav splits it into the raw materials Blaze draws on when generating.

Brand Kit

![Brand Kit](Blaze%20UX%20&%20UI%20Teardown/bd396f56-7018-47a0-bdc3-a021d8ee0823.jpg)

Brand Kit

- **Sub-nav:** Media Library · Brand Style · Brand Voice · Brand Profile · Source Materials.
- **Media Library:** count summary (*3 images, 0 videos*), **+ Add New Media**, grid of asset cards (checkbox, `Used` chip, name, *Image · Uploaded 6 days ago*).
- **Purpose copy:** *“Blaze uses your images and videos to create relevant social posts, blogs, and emails based on your Campaigns.”*

---

### Content Preferences · `/content-preferences`

The guardrails for generation — a long settings form (“Content Guidelines”) that shapes tone, audience, formats and compliance.

Content Preferences

![Content Preferences](Blaze%20UX%20&%20UI%20Teardown/9be4a9b1-2c43-4108-ba28-c89a5633881b.jpg)

Content Preferences

- **Content Guidelines:** language · **Words and concepts to avoid** (chips) · Primary market locations (chips) · **Who you’re speaking to** (age + gender) · **Who appears in content** (age/gender/ethnicity).
- **Further sections:** Content Modification · Video Preferences (music, narrations, captions) · Default Call-to-Action · **Smart Captions** (toggle).

---

### Integrations · `/integrations`

The activation hub — framed as onboarding, not settings. A **0/4** progress ring and numbered, sequenced connect buttons turn account-linking into a checklist.

Integrations

![Integrations](Blaze%20UX%20&%20UI%20Teardown/78cf9c26-f2d6-4c5e-a046-0b4a42500357.jpg)

Integrations

- **Headline + ring:** *“Connect your accounts to automate your marketing”* with a `0/4` ring.
- **Grouping:** **Website traffic** (Google Analytics) · **Social Media** numbered 1–4: Instagram `Next up →`, Facebook, LinkedIn, X/Twitter — each with **Connect**.
- **Support:** **Get Help Live** + **Open Campaigns** reduce drop-off.

---

### Recents & files · `/all_files`

A cross-campaign content index in table form, filterable by asset type — the “everything you’ve made” view.

Recents

![Recents](Blaze%20UX%20&%20UI%20Teardown/a9f55c67-f0af-45b4-aa90-da609c73a822.jpg)

Recents

- **Filter tabs:** All · Docs · Designs · Video.
- **Columns:** #, Preview, Name (title + caption + type icon), Post Date & Time (editable ▾), Post Status (Review badge).

---

### Learnings · `/learnings` *(gated)*

A locked feature sold through a full promo screen. **This is the template for every gated surface:** value headline, a mocked result, a 4-step explainer, benefit cards, one connect CTA.

Learnings (gated)

![Learnings (gated)](Blaze%20UX%20&%20UI%20Teardown/f03456a9-39f5-490a-b457-350117adbe01.jpg)

Learnings (gated)

- **Hero:** *“Enable your marketing to get smarter every week”* + a realistic mock of the locked dashboard.
- **CTA + reducers:** **Connect your Accounts** · `🟢 Takes around 2min` · *+12% engagement lift in first 30 days*.
- **“How it works”:** 4 numbered steps — Connect channels → Blaze analyzes vs 200+ peers → Get action plan (plain English) → **Apply with One Click**.

---

### Insights · `/insights` *(gated)*

Per-platform performance analytics, blurred behind a connect wall — “show the value, withhold it” in its purest form.

Insights (gated)

![Insights (gated)](Blaze%20UX%20&%20UI%20Teardown/3538991c-a706-463c-932a-6e467eb12f49.jpg)

Insights (gated)

- **Layout:** one section per platform (Instagram, Facebook…), each a row of stat tiles (Impressions…) with a range toggle (7 Days).
- **Locked state:** tiles blurred; a centered *“Connect {platform} account to get insights”* + **Connect** overlays each.

---

### Meta Ads · `/paid-ads`

A paid-ads manager with an autonomous A/B testing layer. A 3-step setup banner onboards; a spreadsheet-style table manages spend.

Meta Ads

![Meta Ads](Blaze%20UX%20&%20UI%20Teardown/c03799de-2153-47dc-85d4-e8770450ba29.jpg)

Meta Ads

- **Setup banner:** *“Set up paid ads in three steps:”* ① Connect Meta ② Create Your Campaign ③ Set your budget → **Create your first ad campaign →**.
- **Challenger testing:** toggle — Blaze auto-generates `↗ Challenger` ads vs the `⚑ Champion`, using credits + ≤10% of weekly budget; underperformers auto-pause after 72h.
- **Campaign table:** On/Off · name (Meta glyph) · Budget (daily) · Amount spent (total) · Results (leads) · Cost per result · Status. **+ Create New Campaign**.

---

### SEO / AEO · `/seo-relevance` *(gated · Beta)*

Auto-blogging for search + “answer engine” (AI citation) visibility. Same gated-promo template as Learnings.

SEO/AEO (gated)

![SEO/AEO (gated)](Blaze%20UX%20&%20UI%20Teardown/1f161382-fd6e-4673-b1c9-f60a48fa4827.jpg)

SEO/AEO (gated)

- **Hero:** *“Rank on Google and get cited by AI”* → **Set Up My SEO/AEO Plan →**. A *“How it works”* pill sits by the title.
- **“How Blaze does it”:** 3 icon cards — **Win the right keywords · Publish blog posts consistently · Earn rankings & AI citations**.

---

## 7. Create wizards

“Create New” opens a type picker that mirrors the content hierarchy, then branches into an AI-assisted flow. Both flows are **AI-first**: content is generated, then reviewed — never a blank canvas by default.

Create New modal

![Create New modal](Blaze%20UX%20&%20UI%20Teardown/47ba7a4c-2b5e-4602-8596-4e91480fa68d.jpg)

Create New modal

New Post flow

![New Post flow](Blaze%20UX%20&%20UI%20Teardown/d307c21b-76eb-483b-80c1-f1773ee9865e.jpg)

New Post flow

Create Campaign — step 1

![Create Campaign — step 1](Blaze%20UX%20&%20UI%20Teardown/d30bc7c2-c676-40cc-b174-e6c03a687637.jpg)

Create Campaign — step 1

Create Campaign — step 2

![Create Campaign — step 2](Blaze%20UX%20&%20UI%20Teardown/b7e0c3b1-d65d-4689-abec-fed711990473.jpg)

Create Campaign — step 2

1. **Create New → pick a type** — Post · Campaign · Add Strategy, each with icon + one-line definition, teaching the hierarchy at the point of action.
2. **Give context, not a design** — Campaign flow asks for a Strategy + brief + reference assets (webpage / files / Brand Kit); Post flow auto-suggests a topic and reference image from the campaign.
3. **AI generates a draft** — skeleton-loading states while Blaze writes; a live timer (*“Generating Prompt.. 0:02”*) sets the expectation that this takes real seconds.
4. **Review & regenerate per field** — every generated field has an inline `⟳` regenerate; cheap iteration before committing.
5. **Commit** — **Schedule 1 Post** / **Create Campaign** — the only step that spends the result into the calendar and approval queue.

---

## 8. User journeys

### A · Activation (first session → live autopilot)

1. **Land on a pre-seeded workspace** — sample on-message campaigns already fill Home, Calendar and Approvals. The app demonstrates itself before any setup.
2. **Teach the brand** — Brand Kit (media, voice, profile) + Content Preferences (audience, tone, guardrails) shape what Blaze generates.
3. **Approve the first week** — walk the Approvals / editor queue, nudge posts by chat, Approve All.
4. **Connect accounts (the pivotal step)** — every nudge points here. `0/4 → 4/4` unlocks publishing, Insights and Learnings.
5. **Autopilot + weekly loop** — approved posts publish on schedule; performance feeds Learnings; next week’s campaign generates automatically.

### B · The weekly content loop (steady state)

1. **Campaign auto-generates a week of posts** — status moves `⚪ Generating on…` → ready, across formats.
2. **Posts land in Approvals wearing Review badges** — Home “Up next” surfaces the count; badges make the backlog scannable everywhere.
3. **Refine in the chat editor** — preview per platform, ask Blaze for changes, thumbs-feedback, Previous/Next through the stack.
4. **Approve → schedule → publish** — `🟢 Approve` flips a post into the Calendar; `🔵 Posting` when live. Failures surface with **See Failed Posts**.
5. **Learn & compound** — Insights + Learnings turn results into next-week adjustments — the “smarter every week” promise.

---

## 9. Clone checklist

What actually makes this UX work — the things to get right for Tuezday:

- [ ]  **Model first.** Build the Strategy → Campaign → Post tree before any screen; navigation, wizards and breadcrumbs all derive from it.
- [ ]  **Badge system is the nervous system.** Ship the Review / Posting / Generating pills identically across every surface — it’s how “approve” stays effortless.
- [ ]  **Editing is a conversation.** The three-panel chat editor (suggest → preview-as → publish settings) is the differentiator; don’t reduce it to a form.
- [ ]  **AI-first, human-gated.** Default to generated drafts + per-field regenerate; make Approve the deliberate act.
- [ ]  **Never show an empty app.** Seed workspaces with on-brand sample content.
- [ ]  **Bend the whole app toward one activation goal** (connect accounts) via up-next cards, 0/4 rings, “Next up”, effort tags, social proof and gated previews.
- [ ]  **Quiet visual system, loud state.** Near-white grounds + hairlines + one accent; let semantic color and pills carry meaning.
- [ ]  **Errors are explicit & actionable** — “2 posts failed to publish → See Failed Posts”; inline “Connect ›” where a platform is missing.

---

## 10. Scope & gaps

Captured **read-only** in a demo workspace, triggering flows but stopping before any commit (no credits spent, nothing published). Honest gaps before this is fully buildable:

| Gap | Why it matters | Status |
| --- | --- | --- |
| **“Edit Design” canvas** | How you actually manipulate an image/carousel — the hardest thing to build. | Not opened (chat side only). |
| **First-run onboarding** | Signup → workspace creation → brand setup wizard; the user’s first 10 minutes. | Not seen (workspace pre-seeded). |
| **Exact design tokens** | Real hex, font family, spacing scale, radii, shadows. | Eyedropped approximations only — extractable from the live CSS. |
| **Behind the gates** | Live Insights/Learnings dashboards, OAuth flows, Meta Ads builder, billing. | Only locked promo screens seen. |
| **Dynamic & responsive states** | Hover/loading/error/empty states, animations, mobile/tablet. | Desktop, single width, static only. |
| **Behavior rules** | What triggers “Generating,” scheduling logic, credit cost per action. | Inferred, not confirmed. |

**Highest-leverage next captures:** exact design tokens → the Edit Design canvas → first-run onboarding. These three close most of the distance between “informative reference” and “buildable spec.”

---

*Prepared as an internal reference for the Tuezday team. All observations are from directly viewed screens in a live Blaze workspace.*