# Tuezday: What It Actually Does (Plain English Edition)

> This is a friendlier translation of `docs/whats-actually-built.md`, which is the technical, code-verified inventory of everything built so far. This version explains the same 16 features and the honest list of "things to watch out for" — but in plain language, for someone who wants to understand the product without reading code.

---

## The Big Picture, In One Sentence

Tuezday listens for things worth talking about (news, trends, mentions of your competitors), writes content and messages that sound like your brand, has a human sign off before anything goes out, publishes it automatically on a schedule, watches how people react, and slowly gets smarter about what your brand should say next. That entire loop is real and working — not just a plan on paper.

---

## 1. The Basics: Logins, Workspaces, Teams, and Onboarding

**What it's for:** Every SaaS product needs a way for people to sign up, invite teammates, and set up their account. Nothing fancy here — this is the plumbing everything else sits on top of.

**What it does:**
- Lets people sign up with email/password or "Sign in with Google."
- Lets a company create a "workspace" (their own private area) and invite teammates into it.
- Walks a brand new customer through a 7-step setup: give us your name → give us your website → connect your accounts → verify some details → review your brand "brain" (more on that below) → set up your first campaign → get your first piece of content drafted for you.
- During that setup, Tuezday actually **reads your website** and, if you connect a social account, your past posts — and uses that to write a first draft of your brand's personality, audience, and voice for you to review and correct, instead of handing you a blank form.

**Verdict:** Solid, unglamorous, does its job well. The onboarding in particular is a real feature — it means your very first AI-written post isn't a shot in the dark.

---

## 2. The "Brain" and the Context Resolver — the core idea of the whole product

**What it's for:** This is Tuezday's actual bet: instead of writing one big prompt and hoping the AI "gets" your brand, everything the AI is told about your company comes from one clearly organized, editable source — so you can always see exactly *why* the AI said what it said.

**What it does:**
- Every workspace has **five documents** that describe the brand: **Soul** (who you are), **ICP** (who you're selling to), **Voice** (how you sound), **History** (what's happened before), and **Now** (what's currently going on / top priorities). You can read and edit all five in plain English inside the app, and every past version is saved.
- Before the AI writes *anything* — a social post, an email, an ad — a system called the **Context Resolver** decides which pieces of those five documents, plus any extra notes for that specific channel or campaign, actually get shown to the AI, and in what order. Think of it as a smart assistant that hands the writer a folder of exactly the relevant background notes before they start typing, rather than the writer guessing what's relevant.
- Crucially, **you can inspect that folder before anything is generated** — there's a screen in the app that shows you precisely what the AI is about to be told and why each piece is included. Nothing is hidden or guessed at.

**Verdict:** This is the best-built part of the product relative to what was originally promised. Every single piece of content, no matter the channel, goes through this same "explain yourself first" process.

---

## 3. Writing Drafts, and the Human Approval Step

**What it's for:** AI should never be allowed to post something to the world without a person (or an explicitly pre-approved automatic rule) saying "yes, send this."

**What it does:**
- When it's time to generate content, the system pulls the relevant brand background (from #2 above), asks the AI to write a draft, and **saves a record of exactly what information the AI was given** alongside the draft it produced — so you can always trace back "why did it write this?"
- A **second AI pass then critiques the first draft** — checking whether it sounds on-brand and fits the channel it's meant for — and flags problems before a human even looks at it.
- Every draft moves through a clear approval flow: **draft → waiting for review → approved, rejected, or edited**. Every decision is logged with who made it.
- There's also a **chat-style editor**: instead of rewriting a draft from scratch, you can just tell Tuezday in plain language what to change ("make it punchier," "remove the second paragraph") and it revises the draft for you, keeping a full back-and-forth history.
- You can even approve or reject drafts straight from an email, by clicking a link — no need to log in.

**Verdict:** This part is built thoroughly — arguably *more* thoroughly than strictly necessary (there are four separate layers of quality-checking on every piece of content), but it's coherent and every decision is recorded.

---

## 4. Campaigns

**What it's for:** Content needs a reason to exist. Campaigns are the "why" — the container that groups content around a goal (e.g., "launch our new feature" or "always-on brand awareness").

**What it does:**
- You can create a campaign with a name, a purpose (a one-time push vs. an ongoing effort), a status (draft, active, paused, etc.), and a mode that controls how hands-off it is: fully manual, human-approves-everything, or fully automatic.
- There's also a more detailed **planning layer** where you can define a campaign's objective, target audience, key messages, offers, and calls-to-action, plus separate "lanes" for each channel (e.g., a LinkedIn lane, an email lane) with their own schedules.

**Honest caveat:** Right now there are **two different places** a campaign's strategy can live — a simple free-text summary that the AI actually reads, and the more detailed structured plan that shows up in the dashboard. The AI does not yet read the detailed plan directly, only the free-text summary. So if you fill out the detailed plan but never update the free-text summary, the AI may not know about it.

---

## 5. Discovery — Tuezday listening to the outside world

**What it's for:** So you don't have to manually scroll Reddit, Google News, and Twitter every day looking for things worth reacting to.

**What it does:**
- Tuezday automatically checks a rotating list of sources — news sites, Reddit, Hacker News, YouTube channels, podcasts, Google Trends, funding announcements — for anything relevant to your brand, roughly every 30 minutes.
- It also can watch **specific social accounts** you tell it to track (like a competitor's LinkedIn or Twitter).
- It automatically **filters out duplicates** (the same story from five different sites only shows up once) and sorts new items into a review queue where you (or an automatic rule) decide to accept or skip each one.
- Anything accepted becomes a "signal" — see #6 below — and the AI **scores how relevant it is** to each of your target audiences and campaigns, so the most promising ones bubble to the top.

**Honest caveat:** Of the 14 source types the system knows about, **8 work out of the box with no setup**, 3 more require you to connect a social account first, and 3 (G2, Capterra, "intent" data) are registered in the system but don't actually do anything yet — they're placeholders for later.

---

## 6. Signals — "something happened, should we respond?"

**What it's for:** A single, consistent way to represent "a thing worth possibly writing about," regardless of where it came from.

**What it does:** A signal can come from three places: something a person types in manually, something accepted from the Discovery feed (#5), or something sent in from an outside tool through Tuezday's developer API. Every signal gets scored against your audiences and campaigns, and you (or the campaign's automation setting) can turn any signal directly into a draft response.

---

## 7. Evidence — grounding the AI in facts, not guesses

**What it's for:** Stop the AI from making things up. If it says "as we mentioned last month," that should actually be true.

**What it does:** Tuezday keeps a searchable library of your own real content — things you've published, signals you've responded to, documents you've manually added — and when generating something new, it pulls in the most relevant real snippets as supporting evidence, rather than letting the AI invent facts from nothing. Even better: Tuezday will **suggest** things to add to that library (your own recent posts, accepted signals) but **never adds anything without you clicking accept first**.

---

## 8. The Learning Loop — getting smarter over time

**What it's for:** Every time you approve, reject, or edit a piece of content, that's a signal about what "good" looks like for your brand. That should feed back into the system instead of being thrown away.

**What it does:** Tuezday collects your approval decisions and any engagement metrics you've logged, and periodically (about once a week) has the AI write up a proposed update to your "Now" brain document — essentially "here's what seems to be working, here's what I'd update." Nothing changes automatically; you review and accept or dismiss the proposal.

**Honest caveat:** Right now this mostly learns from your yes/no decisions and metrics you type in by hand — it doesn't yet deeply factor in the automatically-captured engagement metrics from #9 below.

---

## 9. Scheduling, Publishing, and the Inbox

**What it's for:** Once something is approved, it shouldn't need a human to click "post" — it should go out on a sensible schedule, and any replies it gets shouldn't disappear into the void.

**What it does:**
- You set up a **posting calendar** per channel (e.g., "post to LinkedIn Tuesdays and Thursdays at 10am"), and Tuezday automatically fills upcoming slots with approved, ready-to-go drafts.
- A background process checks every minute for anything due to go out, and actually publishes it — to LinkedIn, X (Twitter), Reddit, Instagram, or email — through the real, connected accounts.
- You can tell Tuezday which social account should post on behalf of which persona (e.g., your "founder voice" persona posts from your personal LinkedIn, your "company" persona posts from the company page).
- If a campaign is set to fully automatic, the whole thing runs itself: a signal comes in, gets scored, gets written up, gets auto-approved, gets scheduled, gets posted — all without anyone touching it (with safety caps on how many posts per day).
- An **inbox** watches for comments and DMs on things you've posted, tracks how each post is performing (views, likes, etc. at 24 hours and 7 days), and can even draft — or in fully automatic mode, auto-send — replies.
- A **calendar view** shows everything planned, scheduled, or already posted in one place.

**Verdict:** This is a genuinely complete "set it and forget it" publishing engine. Which is exactly why the safety controls in #12 matter so much.

---

## 10. Reaching Out to Individual Leads (Outbound & CRM)

**What it's for:** Not everything is a public post — sometimes you need to reach a specific person directly (a sales lead, a journalist).

**What it does:**
- You can import a list of leads (by hand or via spreadsheet upload), group them into audiences (fixed lists, or "smart" lists that auto-update based on rules), and generate a personalized outbound email (or DM) for each one, which goes through the same approval process as everything else.
- You can set up **multi-step follow-up sequences** ("send this, wait 3 days, if no reply send this other message"), with daily sending limits and automatic stopping if the person replies.
- It connects to your CRM (customer relationship management tool, like a rolodex with superpowers) to sync contacts back and forth — Tuezday intentionally does **not** try to replace your CRM, just talk to it.
- There's a matching feature for reaching out to journalists and podcasters (PR), including tools to draft pitches and press releases.

---

## 11. Sending Emails Directly (instead of through a separate tool)

**What it's for:** Sending an email safely (without getting flagged as spam, without emailing people who opted out) is a whole discipline of its own. This section is Tuezday's own built-in version of that.

**What it does:** Tuezday can send emails itself — it verifies your sending domain, keeps a suppression list of people who should never be emailed again, checks every recipient's permission status before sending, and listens for bounce/delivery notifications to keep that list accurate.

**Honest caveat, in plain terms:** The original plan was to *not* build this — to just export a spreadsheet and let dedicated email tools (like Smartlead or Instantly) do the sending. Instead, Tuezday quietly built a full in-house version of that same infrastructure, and **kept the spreadsheet-export option too**. Both exist side by side right now. That's a decision someone should make deliberately (use our own system going forward, or route everything through the outside tools) rather than leaving both running.

---

## 12. The Second Approval Gate — "may this actually go out?"

**What it's for:** Approving a *draft* ("this is well-written") is a different question from authorizing it to actually *leave the building* ("yes, post/send/spend money right now"). This section is the safety layer for the second question.

**What it does:** Anything that touches the outside world — publishing a post, sending an email, replying to a comment, launching a paid ad, changing an ad budget — passes through a policy check first. For each campaign, persona, or connected account, you can set the rule to "always ask a human first" or "just do it automatically." There's a bulk "approve everything pending for this campaign" button so it's not death by a thousand clicks, and a full log of every such decision.

**Honest caveat:** By default, a single LinkedIn post can require **two separate yes-clicks** from you — one to approve the draft, one to authorize it going live — unless you've explicitly set that combination to "automatic." That's safer but can feel like double work day to day; a "approve and authorize in one click" shortcut would help.

---

## 13. Ads

**What it's for:** Paid advertising is just another channel, but one where the AI should write the creative and a human should control the spend.

**What it does:**
- **Reporting:** imports your ad account data (currently Meta/Facebook), syncs performance numbers every 6 hours, and lets you link ad campaigns to your Tuezday campaigns to see blended results. If you're not connected, you can upload a spreadsheet instead.
- **Creative:** generates ad copy/image variants through the same brand-aware writing pipeline as everything else, plus actual rendered ad images.
- **Launch & spend control:** ad launches go through their own approval flow, and any changes to a live ad's budget or targeting go through the second approval gate (#12) — plus there's a hard spending cap tied to your subscription plan (the free plan's cap is $0, i.e., ads require a paid plan).

**Honest caveat:** Ads currently have their safety controls spread across two different systems (its own approval flow, plus the general external-action gate) rather than one unified one — works today, worth consolidating eventually.

---

## 14. Making Instagram Carousels and Rendered Images

**What it's for:** An Instagram carousel isn't just text — it's actual designed image slides, and those don't create themselves.

**What it does:** Each workspace can have its own visual design system (colors, fonts, layout templates). When a draft is meant to become a carousel, Tuezday automatically splits the text into slides and renders each one into an actual image using pre-built templates — no manual design work needed. The image files are then stored and ready to publish.

---

## 15. The Homepage: Priorities, To-Dos, and Insights

**What it's for:** With this much happening automatically, you need one place that tells you "here's what needs your attention today."

**What it does:**
- A ranked to-do list surfaces things like: content waiting for your review, failed posts, blocked automations, things needing your authorization, and campaigns that seem to be stalling.
- A separate, simpler checklist tracks your onboarding-style progress (have you set up your brain? do you have active campaigns? is anything stuck?).
- An insights dashboard shows approval rates, channel performance, and ad results, with the ability to export to a spreadsheet.
- You can also set up notifications (email, or chat-app-style webhooks) so you get pinged when something needs a decision, and there's an activity log of everything that's happened.

**Honest caveat:** Right now there are two separate systems computing "what should you look at" (the to-do list and the onboarding checklist), and four separate places that store performance numbers, rather than one unified view. Not broken, just not fully consolidated yet.

---

## 16. The Business Layer: Plans, Developer Access, and the Background Worker

**What it does:**
- **Billing:** three plans (Free, Pro, Scale) with different limits on seats, connected accounts, monthly AI generations, and ad spend — enforced automatically, with Stripe handling payment.
- **Developer API:** other tools can plug into Tuezday — submitting ideas, approving/rejecting drafts, launching campaigns, pulling insights — using a secure API key.
- **AI assistant access (MCP):** Tuezday exposes the same capabilities so that a customer's own AI assistant (like Claude) can, for example, approve their drafts on their behalf.
- **The background worker:** one process quietly runs on a timer, checking every few minutes to hours whether there's discovery to run, content to schedule, posts to publish, replies to check, or ads to sync — this is the "engine room" that makes the automatic parts of the product actually happen without anyone clicking a button.

---

## Things Worth Keeping an Eye On (in plain English)

The technical doc calls these out as tensions in the codebase. Translated:

1. **We built our own email-sending system, even though the original plan said "just use outside tools like Smartlead."** Both now exist side by side. Worth deciding which one is the "real" path going forward.
2. **Some posts require two separate approval clicks** (approve the content, then separately authorize it going live) unless you've set that channel to fully automatic. A "do both at once" shortcut would reduce clicking without reducing safety.
3. **There are two overlapping ways a discovered item gets matched to the right audience/campaign** — an older, simpler method and a newer, more detailed scoring method. They mostly agree, but could occasionally disagree, and having two is more confusing than having one.
4. **There are nine different knobs that affect what the AI is told before it writes anything** (brand docs, channel notes, campaign notes, etc.). Individually each makes sense; together, the only place you can see how they combine is the "what will the AI see" inspector screen — which is good that it exists, but means that screen needs to stay trustworthy and complete.
5. **Ad safety controls live in two separate systems** rather than one.
6. **A campaign's detailed strategic plan and the free-text summary the AI actually reads are two different things**, and they don't automatically stay in sync. If you update the detailed plan but not the summary, the AI won't know.
7. **Two separate systems both try to tell you "what needs your attention today"** on the homepage, computing similar answers slightly differently.
8. **Performance numbers are tracked in four separate places** rather than one unified reporting model.
9. **A few features are "wired up" in the system's vocabulary but don't actually do anything yet** — most notably three discovery sources (G2, Capterra, and generic "intent" signals) that are registered but inert. Not broken — just not built yet, even though they appear in menus/config.
10. **Some technical footnotes** worth knowing but not urgent: the background worker is a single process (fine for now, would need upgrading at large scale), image rendering shares one browser process (worth watching memory usage on), and the database technology used today is the simpler kind, with a more industrial-strength swap planned for later.

---

*This is a plain-English companion to `docs/whats-actually-built.md`, generated the same day (2026-07-25) from the same source material. When in doubt, the technical version and the actual code are the ground truth — this version is for building intuition, not for settling implementation debates.*
