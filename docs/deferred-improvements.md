# Deferred Improvements

> The running backlog of deliberate "good enough for now" choices — the simpler version we shipped to
> keep a sprint scoped, paired with the no-compromise version we'll build later and the trigger to
> revisit. Founder rule (2026-06-21): we never *lose* a compromise; we log it here and upgrade it once
> we hit scale / have users. Add an entry every time the simpler path is chosen.

Each entry: **what we shipped** · **the better version** · **trigger to revisit** · **origin sprint**.

---

## Open

### 1. Email send = CSV export, not a live API push
- **What we shipped (Sprint 26):** Approved per-recipient email messages are exported as a
  Smartlead/Instantly-ready CSV (personalized body as a custom variable). The founder uploads the CSV
  into Smartlead/Instantly to actually send. This sits behind an `OutboundExporter` interface so the
  launch domain never learns how email leaves Tuezday.
- **The better version:** A real API push — using the already-registered `smartlead` / `instantly`
  outbound providers, create the sending campaign and upload the leads + personalized fields via API,
  one click, no manual CSV step. A second `OutboundExporter` implementation; the launch domain is
  untouched.
- **Trigger to revisit:** When manual CSV upload becomes the bottleneck — i.e., real users running
  launches regularly, or a paying customer asks for one-click send.
- **Origin:** Sprint 26 (Targeted campaign launch). Boundary held: we still never build
  deliverability/warmup infra ourselves.

### 2. Launch generation is synchronous (one LLM call per recipient, inline)
- **What we shipped (Sprint 26):** `generateLaunch` loops the audience and calls the LLM once per
  recipient (email + X DM) plus once per broadcast channel, all inside the request — the same shape
  the Sprint 11 outbound drafter uses. Fine for modest segments; a large audience makes the
  `/generate` call slow.
- **The better version:** Enqueue generation on `apps/worker` (the system actor already calls the API
  cross-workspace) and stream/poll progress; the launch sits in `generating` until done.
- **Trigger to revisit:** When a real launch targets more than a few dozen recipients, or `/generate`
  starts timing out.
- **Origin:** Sprint 26.

### 3. Instagram video/reel finalize uses a bounded in-request poll, not async worker finalize
- **What we shipped (Sprint 26):** `InstagramAdapter` publishes images and carousels synchronously;
  for a video/reel it polls the container `status_code` a bounded number of times, then errors with
  "still processing — retry" (the existing publication **retry** route finishes it). No fake success.
- **The better version:** A worker-driven async finalize — create the container, return immediately,
  and let the worker poll + publish when the reel is ready (the same scheduled-publication machinery).
- **Trigger to revisit:** When founders publish reels regularly and the retry step becomes annoying.
- **Origin:** Sprint 26.

### 4. Cadence fill is synchronous on a worker tick
- **What we shipped (Sprint 27):** Each fill creates scheduled `publication` rows inline (one round
  trip per draft), bounded to a 14-day horizon and run every few minutes by the worker. Fine for modest
  volumes.
- **The better version:** Run fill on a dedicated scheduler with sub-minute precision and back-pressure
  for large fan-out.
- **Trigger to revisit:** Large cadence fan-out or a need for sub-minute precision.
- **Origin:** Sprint 27.

### 5. DST-gap wall-clock times resolve to the adjacent valid instant
- **What we shipped (Sprint 27):** The slot math handles normal DST transitions, but the ~1 hour per
  year that *doesn't exist* locally (spring-forward gap) is mapped to the nearest valid instant rather
  than skipped or flagged. Acceptable for a posting scheduler.
- **The better version:** A library-backed implementation that surfaces the ambiguity.
- **Trigger to revisit:** If a customer reports a mis-fired post around a DST boundary.
- **Origin:** Sprint 27.

### 6. Cadence doesn't pre-validate posts at fill time
- **What we shipped (Sprint 27):** Fill derives a title from the draft's first line (covers Reddit's
  title requirement) but doesn't run `validateSocialPost` before scheduling — an invalid post fails its
  receipt at fire time with the platform error (the existing failed-receipt + retry path).
- **The better version:** A pre-flight check that warns before the slot fires.
- **Trigger to revisit:** When fire-time failures on auto-slotted posts become noisy.
- **Origin:** Sprint 27.

### 7. Mailer is fire-and-log behind the interface
- **What we shipped (Sprint 27):** `Mailer` (Resend impl + Console default) has no delivery-tracking
  table, retries, bounce/open webhooks, or templating engine. Invite emails are best-effort (a failure
  never blocks invite creation).
- **The better version:** Delivery tracking + retries + a real template layer.
- **Trigger to revisit:** Arrives with the email-approvals (S39) and billing (S37) sprints that also
  depend on this seam.
- **Origin:** Sprint 27.

### 8. Automation runs synchronously on a worker tick
- **What we shipped (Sprint 28):** `runAutomation` loops each active automated campaign × channel ×
  new signal and calls the LLM inline (one generation per draft), bounded by new-signal volume and run
  every few minutes by the worker. Fine for modest volumes.
- **The better version:** Enqueue generation on a worker queue with back-pressure and progress, so a
  burst of signals across many campaigns doesn't block a single request.
- **Trigger to revisit:** When automated campaigns × channels × signal volume makes a run slow.
- **Origin:** Sprint 28.

### 9. Auto-post guardrail caps are per UTC day
- **What we shipped (Sprint 28):** The per-connection and per-campaign daily caps count posts in the
  UTC calendar day of each candidate slot, ignoring the cadence's own timezone.
- **The better version:** A timezone-aware (per-account-local) daily window.
- **Trigger to revisit:** If a customer's posting day spans a UTC boundary in a way that surprises them.
- **Origin:** Sprint 28.

### 10. Kill switch clears pending auto-posts on the next cadence tick, not instantly
- **What we shipped (Sprint 28):** Turning the kill switch on stops new auto-posting and cancels a
  cadence's pending `scheduled` auto-posts the next time that cadence is filled (≤ the fill interval).
- **The better version:** A check at the publish-fire path so a flipped kill switch halts a due
  auto-post immediately, regardless of the fill cadence.
- **Trigger to revisit:** If the few-minute lag between flipping the switch and a due post matters.
- **Origin:** Sprint 28.

### 12. Inbox polls synchronously on a worker tick
- **What we shipped (Sprint 29):** `pollInbox` fetches replies + engagement per published post/DM
  inline on the inbox tick, one platform call at a time, with no per-post cursors.
- **The better version:** A queue with per-post cursors so high comment/DM volume doesn't serialize
  behind one slow account, and reads resume from the last-seen id instead of re-scanning.
- **Trigger to revisit:** When a workspace has enough published posts / inbound volume that a tick
  takes too long or brushes platform rate limits.
- **Origin:** Sprint 29.

### 13. LinkedIn / X / Instagram read + reply methods are verified-when-creds
- **What we shipped (Sprint 29):** Reddit's `fetchReplies` / `fetchEngagement` / `postReply` are
  tested end to end. LinkedIn, X (DM), and Instagram are written to each platform's real API shape
  but are **untested** without live OAuth apps and elevated access (LinkedIn `r_member_social`, IG
  Business + App Review, X elevated DM access).
- **The better version:** Live-credential verification of each platform's inbound + reply path, with
  fixtures captured from real responses.
- **Trigger to revisit:** When each platform's app + scopes exist (mirrors the S26/S28 social pattern).
- **Origin:** Sprint 29.

### 14. Engagement metrics captured once at the 24h and 7d marks
- **What we shipped (Sprint 29):** `refreshEngagement` upserts one `publication_metrics` row per
  window when its mark passes — a coarse snapshot, not a live curve.
- **The better version:** A polling window that tracks the engagement curve over time (early velocity,
  decay) rather than two point samples.
- **Trigger to revisit:** When the engagement *trend* (not just the 24h/7d totals) drives a decision.
- **Origin:** Sprint 29.

### 15. Auto-reply is per-workspace × per-campaign-mode only
- **What we shipped (Sprint 29):** Auto-reply fires when the workspace master switch is on **and** the
  originating campaign is `scheduled_auto`, within the kill switch + per-connection cap. There is no
  per-channel, per-item-type, or per-sentiment control.
- **The better version:** Finer-grained gating (e.g. auto-reply on LinkedIn comments but never DMs, or
  only on positive-sentiment items).
- **Trigger to revisit:** When a customer wants different auto-reply behavior across channels/sentiment.
- **Origin:** Sprint 29.

### 16. Email reply detection is out of scope (email sequences stop manually)
- **What we shipped (Sprint 29 + 30):** The inbox covers social comments + X DMs. Outbound email is
  CSV-exported to Smartlead/Instantly — there is no inbound-mail channel, so email replies aren't
  detected. Sprint 30's stop-on-reply is therefore **automatic for X DMs** (via the inbox) and
  **manual for email** (a Stop button per recipient / per launch / paste a suppression list of emails).
  Nothing is faked — we never invent an email reply signal we cannot observe.
- **The better version:** An inbound-mail integration (Smartlead/Instantly reply webhook or IMAP) so
  email replies land in the same inbox and stop the chain automatically, like X DMs do.
- **Trigger to revisit:** When real email sequences run at volume and clicking Stop per replied
  recipient becomes painful — build inbound-mail ingest as its own slice, then flip email stop-on-reply
  to automatic.
- **Origin:** Sprint 29 (gap); Sprint 30 (manual stop shipped on top of it).

### 17. Per-connection reply cap counts replies + publications together per UTC day
- **What we shipped (Sprint 29):** The per-connection daily cap on auto-replies counts posted replies
  **plus** publications on that connection in the UTC calendar day — a coarse account-level safety net.
- **The better version:** A timezone-aware budget that distinguishes action types (posts vs replies).
- **Trigger to revisit:** If replies and posts need separate budgets, or the UTC boundary surprises a
  customer (see also #9).
- **Origin:** Sprint 29.

### 18. Email sequence steps still require a manual CSV export per batch
- **What we shipped (Sprint 30):** Even in `scheduled_auto`, the engine auto-generates + auto-approves
  each email step, but the **send** is the founder's manual CSV export → upload to Smartlead/Instantly
  (the deliverability boundary we never cross — ties to #1). The next step's delay clock starts at the
  export (real send) moment, so the engine never gets ahead of actual sends.
- **The better version:** The one-click API push from #1 — approved email steps post straight into the
  Smartlead/Instantly campaign, no manual CSV per batch; the engine learns the send time from the API.
- **Trigger to revisit:** Same as #1 — when manual CSV upload per step becomes the bottleneck.
- **Origin:** Sprint 30.

### 19. The sequence engine advances synchronously on the worker tick
- **What we shipped (Sprint 30):** `runSequences` walks every active recipient inline on each
  worker tick (`SEQUENCE_INTERVAL_MIN`, default 5), generating due steps one per tick per recipient —
  the same synchronous shape as cadence fill (#4) and the inbox poll (#12). Fine for modest audiences.
- **The better version:** A dedicated scheduler with back-pressure for large fan-out and sub-minute
  precision.
- **Trigger to revisit:** Large audiences, many concurrent sequences, or a need for tighter timing.
- **Origin:** Sprint 30.

### 20. Step delays are whole hours, evaluated on the tick
- **What we shipped (Sprint 30):** `delayHours` is a whole-hour integer, and a step fires on the first
  worker tick after `previousStepSentAt + delayHours`. So effective precision is the tick interval
  (≈5 min), and sub-hour cadences aren't expressible.
- **The better version:** Minute-granular delays (and/or send-time-of-day windows) with tick precision
  to match.
- **Trigger to revisit:** A customer needs minute-level or business-hours-aware follow-up timing.
- **Origin:** Sprint 30.

### 21. Sequences cover only the personalized channels (email + X DM)
- **What we shipped (Sprint 30):** A launch's follow-up chain runs on `email` and `x` only. Broadcast
  channels (LinkedIn/Instagram) on the same launch are **not** sequenced — they stay the Sprint 26
  single-shot post. X DM auto-send guardrails reuse the workspace kill switch + per-connection daily
  cap (counting sent DMs), but there's no per-launch DM cadence cap beyond that.
- **The better version:** Multi-channel sequences (e.g. email → LinkedIn touch → email) and richer
  per-step conditions (opened/clicked) once those signals exist.
- **Trigger to revisit:** Demand for cross-channel cadences, or once open/click tracking lands.
- **Origin:** Sprint 30.

### 22. Zoom ranking is lexical BM25 only — no embeddings
- **What we shipped (Sprint 43):** Tier-3 map-then-zoom ranks brain-doc sections against the composed
  task query with in-process BM25 (k1=1.2, b=0.75, shared IDF corpus). Deterministic, dependency-free,
  and fully explainable in the trace — but purely lexical: a query about "pricing" won't pull a section
  that only says "what we charge".
- **The better version:** Hybrid lexical + vector ranking (RRF) now that the gateway has `embed()` and
  the evidence store owns a sqlite-vec index (Sprint 47 / gap-assessment Sprint E) — same seam, zoom
  swaps its scorer.
- **Trigger to revisit:** Brain docs grow past ~50 sections, or the trace/learning loop shows zoom
  repeatedly missing topically-relevant sections phrased with different words. (Sprint 47 built the
  prerequisites — gateway `embed()` + the sqlite-vec index — so this is now a scorer swap, not
  infrastructure.)
- **Origin:** Sprint 43.

### 23. Outline summaries aren't editable
- **What we shipped (Sprint 43):** A doc's outline summaries are machine-made — one best-effort LLM
  pass at save (deterministic first-sentence fallback when the gateway is absent/fails). The founder
  can see them (brain page, resolve trace) but not fix a bad one; the next save regenerates everything.
- **The better version:** Per-section founder-editable summaries with a "locked" flag that survives
  regeneration — the outline is brain content, so humans should get the last word.
- **Trigger to revisit:** An AI summary misrepresents a section in a way that visibly steers drafts,
  or the founder asks to hand-tune the map.
- **Origin:** Sprint 43.

### 24. Zoomed sections duplicate their outline row
- **What we shipped (Sprint 43):** When a doc enters as an outline and zoom pulls sections in full,
  the prompt carries both the outline bullet ("Pricing experiment — …") and the full section body.
  A few tokens of redundancy per zoomed section, kept because the outline preserves the doc's overall
  shape for the model.
- **The better version:** Mark zoomed rows in the rendered outline ("(included in full below)") or
  drop them, saving the duplicate summary tokens without losing the map.
- **Trigger to revisit:** Token-budget pressure on outline-mode bundles, or models visibly echoing
  the summary line instead of the section content.
- **Origin:** Sprint 43.

### 25. Engagement replies don't get persona-scoped guidance
- **What we shipped (Sprint 44):** A reply draft gets the **account** section from the inbox item's
  own `connectionId` (the account the reply publishes from), but its channel guidance stays
  workspace-level — inbox items don't carry a persona, so the scoped-guidance lookup has nothing to
  key on.
- **The better version:** Derive the persona from the item's connection (reverse the
  persona-social-account assignment: which persona is this connection primary for?) and pass it as
  the guidance scope and persona overlay, so replies speak in the owning persona's voice with that
  persona's scoped rules.
- **Trigger to revisit:** Sprint 45 (discovery routing passes persona through `runAutomation`), or
  the founder notices replies ignoring a persona-scoped guidance override that posts respect.
- **Origin:** Sprint 44.

### 26. Guidance scope FKs don't cascade in SQLite (service-level cleanup instead)
- **What we shipped (Sprint 44):** `guidance_overrides.persona_id/campaign_id` are declared
  `ON DELETE cascade` in `schema.ts`, but drizzle-kit's SQLite `ALTER TABLE ADD` drops the action
  (same gap as `publications.cadence_id` in 0021), so `deletePersona` deletes the scoped rows
  explicitly via `deleteGuidanceForScope`. Campaigns have no delete path today, so only the persona
  side needs it.
- **The better version:** Real DB-enforced cascades — free on the planned Postgres swap, since the
  schema already declares them; SQLite would need a table rebuild migration.
- **Trigger to revisit:** The Postgres swap, or a campaign-delete feature (which must then call
  `deleteGuidanceForScope` too — grep for it).
- **Origin:** Sprint 44.

### 27. Re-score on config change is full-backlog, not incremental
- **What we shipped (Sprint 45):** When any persona or campaign changes, the next discovery run
  re-scores **every** still-`new` (untriaged, non-duplicate) item whose `scoredAt` is older than the
  workspace's config watermark (`max(personas.updatedAt, campaigns.updatedAt)`) — not just the items
  actually affected by what changed. One persona edit re-judges the whole triage backlog.
- **The better version:** Incremental invalidation — re-score only the items whose stored matches
  reference the edited persona/campaign (or whose no-match verdict could plausibly flip), so a
  config edit costs LLM calls proportional to its blast radius.
- **Trigger to revisit:** A large untriaged backlog makes a persona/campaign edit visibly expensive
  — a discovery run stalls on re-scoring, or LLM spend spikes after config edits.
- **Origin:** Sprint 45.

### 28. Cross-source duplicates are a linked list, not a merge
- **What we shipped (Sprint 45):** A duplicate stays its own row (own source, own `externalId`)
  with `status: "duplicate"` pointing at the canonical item via `duplicateOfId`; the canonical item
  shows a "seen via N sources" count with an expandable source list. There is no merged/diffed view
  of what differs between the copies, and corroboration doesn't influence the item's score.
- **The better version:** Treat corroboration as signal — a merged view of the linked copies, and
  multi-source pickup feeding relevance ("3 sources picked this up" as a score/rank boost in triage).
- **Trigger to revisit:** When corroboration itself becomes a signal worth surfacing — e.g. the
  founder wants multi-source stories ranked above single-source ones.
- **Origin:** Sprint 45.

### 29. Connected-source cursors are schema-only; every run refetches the newest window
- **What we shipped (Sprint 46 Part 2):** `discovery_sources.cursor_json` exists (Part 1 schema)
  but no connected adapter reads or writes it. Every run fetches the newest ~25 items per source
  (X search/timelines, Reddit listings, LinkedIn posts, IG media) and relies on external-id +
  cross-source dedup for idempotency — correct, but it re-downloads the same recent window and
  can miss items beyond the first page during a burst.
- **The better version:** Store per-mode pagination state (`next_token` for X, `before` fullnames
  for Reddit) in `cursorJson`, fetch newest-first until a known id is seen, and still treat dedup
  as the final guarantee (the spec's stated design).
- **Trigger to revisit:** A tracked account/search that regularly produces more than one page of
  new items between runs, or provider read-quota pressure from refetching unchanged windows.
- **Origin:** Sprint 46.

### 30. Tracked-account provider ids are manual; no resolver populates them
- **What we shipped (Sprint 46 Part 2):** `tracked_social_accounts.external_id` /
  `last_resolved_at` / `last_error` exist, but nothing fills them automatically — a LinkedIn
  author URN must be pasted into `externalId` (or typed as the handle), and X handles are
  re-resolved to user ids on every timeline fetch (one extra API call per handle per run).
- **The better version:** Resolve and cache provider ids on tracked-account create/first use
  (X `users/by/username` → store the id; LinkedIn organization lookup where scopes allow),
  stamping `lastResolvedAt`/`lastError` so the UI can show resolution state.
- **Trigger to revisit:** X read-quota pressure from repeated handle lookups, or founders tracking
  LinkedIn organizations who shouldn't need to know what a URN is.
- **Origin:** Sprint 46.

---

## Done (upgraded)

### 11. No relevance triage — every signal fans out to every automated campaign's channels — **closed by Sprint 45**
- **What we shipped (Sprint 28):** A new signal generates a draft for each channel of every active
  automated campaign, with no scoring of which signal actually fits which campaign/persona.
- **The better version:** Score signal↔campaign/persona fit and route only relevant signals (extends
  `suggestedPersonaId` / `scoreReason`).
- **Closed (Sprint 45, branch `sprint-45-discovery-routing`, 2026-07-03):** `runAutomation` is now
  match-driven — a signal only reaches a campaign with a `signal_matches` row at or above the
  workspace match threshold (Automation settings, default 50), and the draft is generated **as**
  the matched persona. Sprint 31 built the scoring; Sprint 45 made automation consume it, for both
  discovery-sourced signals (accept copies the full multi-candidate match list onto the signal) and
  manually-created ones (auto-matched at `POST /signals`; an explicit persona/campaign pick is a
  single score-100 match with no LLM call).
- **Origin:** Sprint 28.
