# Sprint 29 — Unified engagement & reply inbox

> Phase C, item **A3** in `docs/plans/sprint-guide-21-onward.md` (research Tier-2 #2). That doc is the
> source of truth after the 2026-06-21 no-compromise reorg: **Sprint 29 = the reply inbox**, *not*
> discovery expansion (which is now Sprint 31). A stale memory note had them swapped — corrected.
> **Branch:** `sprint-29-engagement-reply-inbox`, created off **`sprint-28-social-automation`**.
> **Base / required merge order:** this sprint builds on **S28** (social automation modes + guardrails),
> **S26** (targeted launch — social `publishPost`/`sendDm` adapters, X DMs), and **S11** (outbound), plus
> **S27** (cadence/publications) and **S25** (social connections). S28's branch already carries S26+S27
> (which carry S25), so branching off `sprint-28-social-automation` gives the full stack. **The founder
> must merge into `main` in the order: S25 → S26, S27, then S28, then S29.** This spec stands alone: the
> founder resets the session between sprints.

## Goal

Give Tuezday **one surface for the inbound side of distribution**: the replies, comments, and DMs that
come back on the posts we published and the DMs we sent — with **AI-drafted, brain-resolved,
approval-gated** responses, plus **engagement metrics (24h / 7d)** on every published post.

Today distribution is one-way: we publish (S17/S27) and auto-post (S28), but nothing flows back. This
sprint closes the loop:

1. **Inbox.** A worker poll pulls **comments on our published posts** and **replies to our outbound DMs**
   per connected social account into a unified `inbox_items` table — idempotent, threaded to the post/DM
   they answer. The founder sees them in one place with `unread / read / replied / dismissed` status.
2. **Reply through the gate.** From an inbox item, **"Draft reply"** runs the existing brain-resolved
   generation pipeline (a new `engagement_reply` task type, the inbound conversation injected, persona +
   campaign inherited from the original post/DM). The reply lands at the **approval gate** like any other
   draft. Approve → it posts back to the platform as a comment/DM reply; the item flips to `replied`.
3. **Configurable automation.** Whether a reply auto-posts is the **founder's choice** (founder decision
   2026-06-22 — "the user should have the flexibility of choosing what's gated vs automated"). A workspace
   **auto-reply master switch** (default **off**), combined with the originating campaign's existing S28
   `automationMode`, decides: a reply on a `scheduled_auto` campaign auto-approves (system actor, logged,
   reversible) and posts **only when the master switch is on**; everything else waits at the gate. The S28
   **guardrails** (kill switch + per-connection daily cap) bound auto-replies the same way they bound
   auto-posts.
4. **Engagement metrics.** A metrics refresh captures each published post's counts (likes / comments /
   shares / impressions / clicks, where the platform exposes them) at the **24h** and **7d** marks into a
   new `publication_metrics` table, surfaced on the post.

**Founder acceptance (roadmap):** "A reply to a posted comment appears in the inbox → AI drafts a reply →
approve → it posts; engagement numbers show on the post."

This reuses end to end: the **generation pipeline + resolver** (S4/S9), the **approval gate** (S5,
`services/drafts.ts`), the **social adapter boundary + connector fabric** (S17/S25/S26), the **publish
receipt** model (S17), the **worker-tick** pattern (S27/S28), and the **ads/social guardrail** shape
(S20/S28). The genuinely new machinery is the **inbox poller + reply orchestrator**, the **adapter
read/reply methods**, and the **publication-metrics capture**.

## Founder decisions captured (2026-06-22)

1. **Engagement metrics → a new `publication_metrics` table** keyed to `publicationId` (platform-pulled
   snapshots at 24h/7d). It stays **separate from the existing `engagement_metrics`** table, which is
   draft-keyed, manual/free-form, and feeds the learning loop. (Extend-existing option declined.)
2. **Reply automation is configurable by the user**, not hardcoded. Implemented as a per-workspace
   **`autoReplyEnabled`** master switch (default off) × the originating campaign's S28 `automationMode`:
   auto-reply happens only for items mapped to a `scheduled_auto` campaign **and** with the master switch
   on, within the S28 kill-switch + per-connection cap. Per-campaign granularity comes free from the
   existing `automationMode`; finer-grained (per-channel / per-item-type) control is logged as deferred.
3. **Implement LinkedIn + X reply/engagement concretely**, not just Reddit-behind-the-boundary — to each
   platform's real API shape. Reddit is the only one testable today (creds), so tests cover Reddit end to
   end + the boundary; LinkedIn/X/Instagram ship to real shape, **verified-when-creds** (the S26/S28
   pattern — flagged in `docs/deferred-improvements.md`).

## What already exists (foundation — read before building)

- **Social adapter boundary** (`connectors/social/index.ts`). `SocialAdapter` = `publishPost` (+ optional
  `sendDm`, X only). `socialAdapterFor(fabric, provider, connection)` returns the per-provider adapter
  (Reddit/LinkedIn/Instagram/X). Adapters call the fabric's `proxyJson`/`proxyGet`; **credentials never
  enter Tuezday's DB**. We **add optional read/reply methods** to this interface (below).
- **Connector fabric** (`connectors/fabric.ts`). `proxyJson(method, path, connId, integrationKey, opts)`
  (`opts.body` JSON / `opts.form` url-encoded / `opts.headers` / `opts.baseUrlOverride`) and `proxyGet`.
  All adapter reads go through these. Tests inject a fake fabric.
- **Publications** (`services/publications.ts`, table `publications`). A receipt per published post:
  `draftId`, `connectionId`, `providerKey`, `target`, `externalId` (platform post id), `externalUrl`,
  `status` (`scheduled|published|failed`), `publishedAt`. We poll comments/engagement **for `published`
  rows that have an `externalId`**.
- **Launch messages** (table `launch_messages`, S26). One row per outbound recipient message; for X DMs
  `kind` is set, `recipientHandle` holds the @handle, `externalId` holds the X `dm_event_id`, `channel`
  is `x`, `publicationId`/`draftId` link the content. We poll **DM replies** against the X connection and
  thread them to the matching launch message by `recipientHandle`.
- **Approval gate** (`services/drafts.ts`). `submitDraft(db, input, actor)` → a draft at `pending_review`
  logging a `submit` decision; `applyDraftAction(db, draft, "approve", actor)` → `approved` logging an
  `approve` decision with the actor (`system` for auto). The gate is generic — replies reuse it verbatim.
- **Signal→draft generator** (`services/signal-drafting.ts` `generateSignalDraft`). The shared
  brain-resolved pipeline (resolve context → `llm.generate` → `storeGeneration` → `submitDraft`). The
  reply generator mirrors it but with the **inbound conversation** injected instead of a market signal.
- **Resolver** (`packages/brain/src/resolver.ts`). `resolveContext(input)` builds the inspectable context
  bundle. It already injects `signal`, `lead`, `mediaContact`, `evidence` as ordered sections with a
  trace. We **add a `conversation` layer + `ResolveConversation` input** for the inbound message + our
  original post, and an `engagement_reply` entry in `TASK_INSTRUCTIONS`.
- **S28 automation settings + guardrails** (`services/automation.ts`, table `social_automation_settings`).
  `getSocialAutomationSettings` (defaults when no row), `checkPostGuardrails` (kill switch / per-connection
  / per-campaign caps, per UTC day via `utcDayBounds`). The reply auto-path reuses the kill switch +
  per-connection cap. We **add `autoReplyEnabled`** to this settings row.
- **Campaigns** (`services/campaigns.ts`). `automationMode` (`manual|human_in_the_loop|scheduled_auto`)
  is on the campaign. A reply inherits the campaign of the original post's draft → its mode drives
  auto-reply eligibility.
- **Worker** (`apps/worker/src/index.ts`). Per-workspace ticks call API endpoints as the **system** actor.
  Order is automation → cadence → publish. We **add an `inboxTick`** that polls + refreshes metrics +
  runs the reply orchestrator + posts approved replies.
- **`buildApp` composition root.** One new route group; reuse the existing `db`, `llm`, `evidence`,
  `connectors` (fabric), `fetcher` deps — **no new external dependency**.

## Contracts (`packages/contracts/src/index.ts`) — additive only

- **Reply task type:** `TASK_TYPES += "engagement_reply"` (after `instagram_post`). No new channel — a
  reply targets the post's existing channel.
- **Inbox vocabulary:**
  - `INBOX_ITEM_KINDS = ["comment", "dm"] as const`; `InboxItemKind` — a comment on our post, or a DM reply.
  - `INBOX_ITEM_STATUSES = ["unread", "read", "replied", "dismissed"] as const`; `InboxItemStatus`.
  - `inboxItemSchema` — `{ id, workspaceId, connectionId, providerKey, kind: enum(INBOX_ITEM_KINDS),
    channel: enum(CHANNELS), externalId, parentExternalId: nullable, publicationId: nullable,
    launchMessageId: nullable, authorHandle, authorName, content, url: nullable,
    status: enum(INBOX_ITEM_STATUSES), replyDraftId: nullable, postedReplyExternalId: nullable,
    postedReplyUrl: nullable, externalCreatedAt: int, createdAt: int, updatedAt: int }`.
  - `inboxItemWithContextSchema` — `inboxItemSchema` + `{ replyDraft: { id, state, content } | null,
    post: { publicationId, title, url } | null }` (the joined reply draft + the post it answers, for the UI).
  - `updateInboxItemStatusInputSchema` — `{ status: z.enum(["read", "dismissed"]) }` (the only
    hand-settable transitions; `replied` is set by the system on a successful reply post).
- **Engagement metrics:**
  - `METRIC_WINDOWS = ["24h", "7d"] as const`; `MetricWindow`.
  - `publicationMetricSchema` — `{ id, workspaceId, publicationId, window: z.enum(METRIC_WINDOWS),
    likes: int().nullable(), comments: int().nullable(), shares: int().nullable(),
    impressions: int().nullable(), clicks: int().nullable(), capturedAt: int, createdAt: int }`.
- **Run results** (for the `/inbox/run` endpoint + worker logging):
  - `inboxRunResultSchema` — `{ polled: int, newItems: int, metricsCaptured: int, repliesGenerated: int,
    repliesAutoApproved: int, repliesPosted: int, ranAt: int }`.
- **Settings:** extend `socialAutomationSettingsSchema` + `updateSocialAutomationSettingsInputSchema`
  with `autoReplyEnabled: z.boolean()` (schema) / `.optional()` in the partial update. The pinned
  settings expectations in `automation.test.ts` gain `autoReplyEnabled: false`.

No existing vocabulary is changed. `publicationSchema` is **unchanged**; the publications list endpoint
returns the richer object with an added `metrics` array (an API-response shape, not the core contract).

## Data model (migration `0022`, off `0021`)

Edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api` (commit the generated SQL).
Postgres-portable (text ids, integer epoch-ms, integer 0/1 booleans).

### `inbox_items` (new)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `connectionId` | text NOT NULL → connections (cascade) | the account the item arrived on |
| `providerKey` | text NOT NULL | denormalized (`reddit`/`linkedin`/`twitter`/`instagram`) |
| `kind` | text NOT NULL | an `InboxItemKind` (`comment`/`dm`) |
| `channel` | text NOT NULL | a `Channel` — drives the reply's resolver channel |
| `externalId` | text NOT NULL | platform id of the inbound item (idempotency key) |
| `parentExternalId` | text | id of the thing it replies to (our post/comment/DM) |
| `publicationId` | text → publications (set null) | the published post it engages, when mappable |
| `launchMessageId` | text → launch_messages (set null) | the outbound DM it replies to (X) |
| `authorHandle` | text NOT NULL default '' | who sent it (display) |
| `authorName` | text NOT NULL default '' | |
| `content` | text NOT NULL | inbound body |
| `url` | text | permalink on platform |
| `status` | text NOT NULL default 'unread' | an `InboxItemStatus` |
| `replyDraftId` | text → drafts (set null) | the gated reply draft |
| `postedReplyExternalId` | text | platform id of our posted reply |
| `postedReplyUrl` | text | |
| `externalCreatedAt` | integer NOT NULL | when created on platform |
| `createdAt` | integer NOT NULL | |
| `updatedAt` | integer NOT NULL | |

Unique index `inbox_items_connection_external` on `(connectionId, externalId)` — idempotent polling.

### `publication_metrics` (new)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `publicationId` | text NOT NULL → publications (cascade) | |
| `window` | text NOT NULL | a `MetricWindow` (`24h`/`7d`) |
| `likes` `comments` `shares` `impressions` `clicks` | integer (nullable) | platform-dependent |
| `capturedAt` | integer NOT NULL | |
| `createdAt` | integer NOT NULL | |

Unique index `publication_metrics_pub_window` on `(publicationId, window)` — one snapshot per window
(captured once when the window is reached; later refresh upserts the same row — see service).

### `social_automation_settings` (alter)
- `auto_reply_enabled integer NOT NULL DEFAULT 0` — master switch for auto-posting replies.

(`db:generate` may emit the ALTER via SQLite table-recreate; verify the column lands + tests green.)

## Social adapter additions (`connectors/social/index.ts`)

All new methods are **optional** so adapters implement only what their platform supports; the poller
feature-detects (`adapter.fetchReplies?.(…)`).

```ts
export interface InboundReply {
  externalId: string;
  parentExternalId?: string;
  authorHandle: string;
  authorName?: string;
  body: string;
  url?: string;
  createdAt: number; // epoch ms
}
export interface PostEngagement {
  likes?: number; comments?: number; shares?: number; impressions?: number; clicks?: number;
}
export interface PostRef { externalId: string; target?: string }

export interface SocialAdapter {
  publishPost(input: PublishPostInput): Promise<SocialPostResult>;
  sendDm?(input: { recipientHandle: string; body: string }): Promise<SocialPostResult>;
  // Sprint 29 — inbound:
  fetchReplies?(post: PostRef): Promise<InboundReply[]>;          // comments on our post
  fetchEngagement?(post: PostRef): Promise<PostEngagement>;       // counts on our post
  postReply?(input: { parentExternalId: string; body: string; target?: string }): Promise<SocialPostResult>;
  fetchDmReplies?(input: { recipientHandle: string; sinceMs?: number }): Promise<InboundReply[]>; // X DM replies
}
```

### `connectors/social/reddit.ts` (concrete — testable)
- `fetchReplies({ externalId })`: GET `/comments/{id}` (id = `externalId` stripped of the `t3_` prefix),
  `baseUrlOverride` `https://oauth.reddit.com`, UA header. Reddit returns `[postListing, commentsListing]`;
  map `commentsListing.data.children` of `kind === "t1"` to `InboundReply` (`externalId` = `t1_…` name,
  `parentExternalId` = `data.parent_id`, `authorHandle`/`authorName` = `data.author`, `body` = `data.body`,
  `url` = `https://reddit.com{data.permalink}`, `createdAt` = `data.created_utc * 1000`). Skip our own
  authored comments by author match where known (best-effort; dedupe is by `externalId` anyway).
- `fetchEngagement({ externalId })`: GET `/api/info?id={externalId}` → `data.children[0].data`:
  `likes = score`, `comments = num_comments`. (No impressions/clicks from Reddit.)
- `postReply({ parentExternalId, body })`: POST `/api/comment` form `{ api_type: "json",
  thing_id: parentExternalId, text: body }`. Surface in-band `json.errors` like `publishPost` does.
  Returns `{ externalId: created.name, url: created permalink || "" }`.

### `connectors/social/linkedin.ts` (concrete — verified-when-creds)
- `fetchEngagement({ externalId })`: GET `/v2/socialActions/{urn}` (urn = the ugcPost id) → map
  `likesSummary.totalLikes` → likes, `commentsSummary.aggregatedTotalComments` → comments.
- `fetchReplies({ externalId })`: GET `/v2/socialActions/{urn}/comments` → map elements
  (`actor`, `message.text`, `id`, `created.time`). Needs `r_member_social`; flagged untested.
- `postReply({ parentExternalId, body })`: POST `/v2/socialActions/{urn}/comments` with
  `{ actor: authorUrn(), message: { text: body } }`. Real shape; untested.

### `connectors/social/x.ts` (concrete — verified-when-creds)
- X is DM-only here, so it implements the **DM** side, not post comments:
  - `fetchDmReplies({ recipientHandle, sinceMs })`: GET `/2/dm_events?dm_event.fields=...` (or the
    conversation events), filter events from the recipient (sender id ≠ our `users/me` id) newer than
    `sinceMs`; map to `InboundReply` (`externalId` = dm event id, `body` = text, `authorHandle` =
    recipient). Resolve the recipient id via the existing `resolveUserId` helper.
  - `postReply({ parentExternalId, body, target })`: send a DM into the conversation — reuse the
    `sendDm` path (`/2/dm_conversations/with/{userId}/messages`) where the recipient is carried in
    `target`. Real shape; untested.
  - `fetchReplies`/`fetchEngagement` are **not** implemented (no public post).

### `connectors/social/instagram.ts` (concrete — verified-when-creds, best-effort)
- `fetchReplies`/`fetchEngagement` via the Graph API `/{ig-media-id}/comments` and `/{ig-media-id}/insights`
  where available; `postReply` via `/{comment-id}/replies`. IG comment access needs an IG Business account
  + App Review; implement to shape, flag untested. (Acceptable to leave methods unimplemented if the Graph
  shape is uncertain — the poller skips adapters that don't implement them.)

## Services

### `services/engagement-reply.ts` — the reply generator (mirrors `signal-drafting.ts`)
```ts
export async function generateEngagementReply(
  db, llm, evidence, workspace, item: InboxItem,
  ctx: { post?: { title: string; content: string }; persona?: Persona; campaign?: Campaign },
  actor: DraftActor,
): Promise<Draft>   // resolves engagement_reply context (inbound conversation injected) → generate → store → submitDraft
```
Resolves with `taskType: "engagement_reply"`, `channel: item.channel`, persona/campaign overlays from the
original post's draft, and a new `conversation` injection: `{ originalPost: ctx.post?.content,
inboundAuthor: item.authorHandle, inboundMessage: item.content, source: item.providerKey }`. Stores the
generation (taskType `engagement_reply`), then `submitDraft` linked to `campaignId` + `personaId`. The
created draft id is written back to `inbox_items.replyDraftId`.

### `services/inbox.ts` — poller, metrics, orchestrator, queries
- **Queries:** `listInbox(db, ws, status?)` → `InboxItemWithContext[]` (join reply draft + post);
  `getInboxItem(db, ws, id)`; `setInboxStatus(db, ws, id, status)` (read/dismiss; guards `replied`).
- **`pollInbox(db, fabric, ws, nowMs)`** — for each **connected social** connection in the workspace:
  - **Comments:** for each `published` publication on that connection with an `externalId`, if the adapter
    implements `fetchReplies`, fetch and **upsert** each reply as an `inbox_items` row (`kind: "comment"`,
    `publicationId` set, `channel` from the publication's draft, idempotent on `(connectionId, externalId)`,
    `status: "unread"`). Skip replies whose `externalId` we already posted (`postedReplyExternalId`).
  - **DM replies:** for the X connection, for each distinct `recipientHandle` among this connection's
    outbound `launch_messages` (kind = X DM), if the adapter implements `fetchDmReplies`, fetch since the
    newest known item for that handle and upsert (`kind: "dm"`, `launchMessageId` matched by handle,
    `channel: "x"`).
  - Per-connection / per-post failures are caught and counted, never abort the run (publish-tick pattern).
  - Returns `{ polled, newItems }`.
- **`refreshEngagement(db, fabric, ws, nowMs)`** — for each `published` publication with an `externalId`
  whose adapter implements `fetchEngagement`: for each window in `METRIC_WINDOWS` whose mark has passed
  (`24h` = publishedAt+24h, `7d` = +7d) **and not yet captured**, fetch counts and **upsert**
  `publication_metrics` `(publicationId, window)`. Returns `{ metricsCaptured }`. (Captures once per window
  when due; continuous live refresh is deferred.)
- **`runReplyOrchestrator(db, llm, evidence, fabric, ws, actor, nowMs)`** — the auto path:
  - Load `getSocialAutomationSettings`. If `!autoReplyEnabled` or `killSwitch` → generate/auto-approve
    nothing (still allow `postApprovedReplies` to run for manually-approved drafts).
  - For each `unread`/`read` item **without** a `replyDraftId**, resolve its campaign via the original
    post's draft (`publicationId → draftId → campaignId`; DMs via `launchMessageId → draftId → campaignId`).
    If that campaign is **`scheduled_auto`**: `generateEngagementReply(...)`, then if
    `checkPostGuardrails(killSwitch + per-connection cap)` passes, `applyDraftAction("approve", SYSTEM)`.
    Items with no campaign / non-auto campaign are left for the founder (no draft generated automatically).
  - Returns `{ repliesGenerated, repliesAutoApproved }`.
- **`postApprovedReplies(db, fabric, ws)`** — for each inbox item whose `replyDraftId` is an **`approved`**
  draft with no `postedReplyExternalId` yet: re-check the per-connection cap + kill switch (auto items
  only — a manually-approved reply on a `manual` campaign always posts), call the adapter
  (`postReply` for comments, the DM path for `dm`), store `postedReplyExternalId`/`postedReplyUrl`, set the
  item `status: "replied"`, and emit a `reply.posted` event. Failures land on the item (a `lastError`-style
  note via `updatedAt`; the draft stays approved so a retry re-posts). Returns `{ repliesPosted }`.
- **`runInbox(db, llm, evidence, fabric, ws, actor, nowMs)`** — orchestrates the four in order:
  `pollInbox → refreshEngagement → runReplyOrchestrator → postApprovedReplies`, summing into
  `InboxRunResult`. This is the single worker + "Run now" entry point.

### `services/publications.ts` — metrics on the list
Add `listPublicationMetrics(db, ws, publicationId)` and include a `metrics: PublicationMetric[]` array on
the objects returned by `listPublications` (group-load all metrics for the workspace's publications in one
query, attach by `publicationId`). The core `publicationSchema` is untouched; the list response is richer.

### `services/automation.ts` — settings field
`getSocialAutomationSettings` returns `autoReplyEnabled` (default `false`); `updateSocialAutomationSettings`
accepts it in the patch. `checkPostGuardrails` is reused unchanged (the reply path passes the connection +
campaign; for the per-connection cap, posted replies count toward the connection's daily total — they are
posts on that account). A small helper `countConnectionRepliesForDay` is **not** needed: replies are
counted by reusing the publications/replies tally — see note. (Implementation detail: for the per-connection
cap on replies, count `inbox_items` with a `postedReplyExternalId` set that UTC day on that connection, plus
the existing publication count — documented in the function.)

## API routes (`routes/inbox.ts` → `registerInboxRoutes(app, db, llm, evidence, connectors)`)
Thin; `workspaceOr404` like siblings; register in `app.ts` after automation. Uses `actorOf(request)`
(system when the worker calls).
- `GET   /workspaces/:id/inbox` — list items (`?status=` filter) as `InboxItemWithContext[]`, newest first.
- `PATCH /workspaces/:id/inbox/:itemId` — set status (`read` / `dismissed`); 404 `inbox_item_not_found`.
- `POST  /workspaces/:id/inbox/:itemId/reply` — generate a brain-resolved reply draft for this item
  (idempotent: returns the existing `replyDraftId` draft if present); 404 if the item is gone. The founder
  then approves it on the **Review** page (the generic draft action endpoint), and it posts on the next
  `/inbox/run` (or via the post step). Returns the draft.
- `POST  /workspaces/:id/inbox/:itemId/post-reply` — post the (already `approved`) reply draft now and
  flip the item to `replied`; 409 `reply_not_approved` if the draft is not approved, 409 `already_replied`.
  (A "post now" affordance so acceptance doesn't wait for a tick.)
- `POST  /workspaces/:id/inbox/run` — run the full orchestrator now (`runInbox`) → `InboxRunResult`
  (worker entry + a manual "Run now").
- `GET   /workspaces/:id/publications` (existing route, extended) — now returns each publication with its
  `metrics` array.

Error vocabulary: `workspace_not_found`, `inbox_item_not_found`, `reply_not_approved`, `already_replied`,
`invalid_input`.

## `buildApp` wiring & worker
- `app.ts`: `registerInboxRoutes(app, db, llm, evidence, connectors)` (the fabric is the existing
  `connectors` dep). Publications route already registered — extend its handler to include metrics.
- `apps/worker/src/index.ts`: add **`inboxTick`** (`INBOX_INTERVAL_MIN`, default **5**): `POST
  /workspaces/:id/inbox/run` for every workspace, logging `{ newItems, metricsCaptured, repliesPosted }`,
  quiet when nothing happened. Place it **after** `publishTick` in the loop (replies react to what was
  posted) with the same per-workspace try/catch resilience. Update the startup banner + the env-var list.

## Web (`apps/web`)
- **Inbox page** (`app/workspaces/[id]/inbox/page.tsx`, top-level nav item near Review/Calendar): a list of
  inbox items grouped/filterable by status, each showing author, inbound text, the post it answers (link),
  and channel/provider badge. Per item: **Draft reply** (calls `/inbox/:id/reply`, shows the generated
  draft inline with its approval state), **Approve** (when a reply draft is `pending_review` — calls the
  generic draft approve, then `/inbox/:id/post-reply`), **Mark read** / **Dismiss**. A **Run inbox now**
  button shows the `InboxRunResult`.
- **Automation settings** (`app/workspaces/[id]/automation/page.tsx`, existing S28 page): add the
  **Auto-reply** master switch with a one-line explainer ("When on, replies on scheduled-auto campaigns are
  auto-approved and posted within the kill switch + per-connection cap").
- **Publications/Calendar surface**: show each published post's latest engagement numbers (24h/7d) from
  `metrics` (small inline stats). Wherever the published list renders (the S17 "Published" panel /
  Calendar), add a compact metrics line.
- **Review page**: a reply draft (`taskType: engagement_reply`) is just another draft at the gate — it
  already appears. Add the `engagement_reply` label to the `TASK_LABELS` maps (approvals/sandbox/resolver/
  learning pages each keep an exhaustive `Record<TaskType,…>` — all must gain the key or typecheck fails).

## Boundary
- **Reuse, don't rebuild.** The inbox = poller + reply orchestrator + metrics capture only. All reply
  generation goes through the existing brain-resolved pipeline; all reply posting + reads go through the
  existing social adapter boundary + fabric; the gate is the existing one. No new send/deliverability infra.
- **Gate is always real.** A reply is a normal gated draft. Auto-reply performs a true `approve` attributed
  to `system`, logged in `approvalDecisions`, reversible. It happens **only** when the founder turns on the
  master switch **and** the originating campaign is `scheduled_auto`, within the kill switch + per-connection
  cap. Everything else waits for a human.
- **Official APIs via Nango only** (inherited from S25/S26); secrets stay in `.env`/Nango, never in the DB
  or logs. No scraping for reads or replies.
- **Reddit is the tested platform.** LinkedIn/X/Instagram read/reply methods ship to real API shape,
  verified-when-creds (flagged deferred). Email has no inbound channel (we CSV-export to Smartlead/Instantly,
  we don't send), so **email reply detection is out of scope** — noted for S30 (stop-on-reply) to revisit
  when inbound mail exists.
- **Metrics captured once per 24h/7d window**, not continuously; a coarse poll, not analytics.

## Deferred-improvements entries to add (`docs/deferred-improvements.md`)
12. **Inbox polls synchronously on a worker tick**, fetching replies/engagement per published post inline;
    high post/comment volume wants a queue + per-post cursors.
13. **LinkedIn / X / Instagram read+reply methods are verified-when-creds** — written to each platform's
    real API shape but untested without live OAuth apps + (LinkedIn `r_member_social`, IG Business + App
    Review, X elevated DM access). Reddit is the only end-to-end-tested platform.
14. **Engagement metrics are captured once at the 24h and 7d marks**, not refreshed continuously; a live
    polling window would track the curve.
15. **Auto-reply is per-workspace × per-campaign-mode** (master switch × `scheduled_auto`); finer-grained
    control (per-channel, per-item-type, per-sentiment) is a follow-on.
16. **Email reply detection is out of scope** (no inbound mail — outbound email is CSV-exported to
    Smartlead/Instantly); S30 stop-on-reply will need an inbound-mail integration first.
17. **Per-connection reply cap counts replies + publications together per UTC day** — a coarse account-level
    safety net; a tz-aware, action-typed budget would be more precise.

## Tests (`apps/api/test/inbox.test.ts`)
Model on `automation.test.ts` / `publish.test.ts`: `buildAuthedApp` + `createTestDb`, a **fake
`ConnectorFabric`** whose `proxyJson`/`proxyGet` return canned Reddit comment/info/comment-submit payloads,
`fakeLlm`, `vi.useFakeTimers` with a fixed clock, and a `connectReddit()` + publish helper. Seed a published
publication by submitting+approving a draft and publishing it via the fake fabric (or insert the receipt
directly with an `externalId`).

1. **Contracts:** `INBOX_ITEM_KINDS`/`INBOX_ITEM_STATUSES`/`METRIC_WINDOWS`; `TASK_TYPES` includes
   `engagement_reply`; `inboxItemSchema`, `publicationMetricSchema`, `inboxRunResultSchema`,
   `updateInboxItemStatusInputSchema` parse; `socialAutomationSettingsSchema` round-trips with
   `autoReplyEnabled`.
2. **Poll comments:** a published Reddit post + fabric returning two `t1` comments → `POST /inbox/run` (or
   `/inbox/poll` via run) → 2 `inbox_items` (`kind: comment`, `publicationId` set, `status: unread`),
   threaded to the post. **Idempotent** — a second run with the same payload adds 0; a new comment adds 1.
3. **Engagement metrics:** publish a post, advance the clock past 24h → run → one `publication_metrics`
   `24h` row with the fabric's like/comment counts; `GET /publications` shows the post with `metrics`.
   Advance past 7d → run → a `7d` row; re-running before the next window adds nothing.
4. **Manual reply through the gate:** an unread item → `POST /inbox/:id/reply` → a draft at `pending_review`
   linked via `replyDraftId`, `taskType: engagement_reply`, channel = the post's; not posted. Approve it
   (generic draft action) → `POST /inbox/:id/post-reply` → the fake fabric receives `/api/comment`, the item
   flips to `replied` with `postedReplyExternalId`/`url`. `post-reply` before approval → 409
   `reply_not_approved`; after → 409 `already_replied`.
5. **Status transitions:** `PATCH /inbox/:id {status:read}` then `{dismissed}` persist; an invalid status →
   400; setting `replied` by hand → 400 (not allowed).
6. **Auto-reply ON, scheduled_auto campaign:** master switch on + a `scheduled_auto` campaign owning the
   post + an unread comment → run → a reply draft **auto-approved** (latest decision actor `system`) and
   **posted** (item `replied`), all in one run. The decision log shows submit→approve by `system`.
7. **Auto-reply gated:** master switch **off** (default) with a `scheduled_auto` campaign → run generates
   no auto reply (item stays unread, no `replyDraftId`); a `manual`/HITL campaign with the switch on → still
   no auto reply. (Replies only auto-fire on scheduled_auto **and** switch on.)
8. **Guardrail — kill switch / per-connection cap:** kill switch on → auto-reply posts nothing; set
   `perConnectionDailyCap: 1` with one post already published that day → an auto-reply on that connection is
   blocked by the cap (manual posting/manually-approved reply still allowed).

`npm test` + `npm run typecheck` green across all workspaces.

## Founder acceptance (append to `docs/founder-acceptance-tests.md`)
With a social account connected (Reddit works today; LinkedIn/X/Instagram once their creds + API access
exist), at least one **published** post, and the worker running (or use **Run inbox now**):
1. **A reply appears in the inbox.** Reply to one of your published Reddit posts from another account →
   **Inbox → Run inbox now** (or wait for the tick) → the comment appears as `unread`, linked to the post.
2. **AI-drafted, gated reply.** Open the item → **Draft reply** → a brain-resolved reply draft appears at
   the gate → review it on **Review** → **Approve** → **Post reply** → the reply posts back on Reddit and
   the item flips to **replied** with a working link.
3. **Engagement numbers.** After ~24h (or with the clock advanced in dev), the post shows likes/comments at
   the 24h mark; after ~7d, the 7d snapshot appears.
4. **Auto-reply (opt-in).** Automation settings → turn **Auto-reply** on; set a campaign that owns a post to
   **Scheduled-auto** → a new comment on that post → **Run inbox now** → the reply is **auto-approved**
   (badged, decision log shows `system`) and **posts automatically**, subject to the kill switch + caps.
   Turn the kill switch on → auto-replies stop; manual reply + approval still works.

## Step plan
1. Branch off `sprint-28-social-automation` (done) — carries S25/26/27/28. Verify base green.
2. Spec (this file).
3. Contracts: `engagement_reply` task type; inbox + metric vocab + schemas; `inboxRunResultSchema`;
   `autoReplyEnabled` on social-automation settings. Update the pinned settings expectation.
4. Schema + migration `0022`: `inbox_items`, `publication_metrics`, `social_automation_settings.auto_reply_enabled`.
5. Resolver: `conversation` layer + `ResolveConversation` input + `engagement_reply` TASK_INSTRUCTIONS entry.
6. Adapter boundary: add the optional read/reply methods; implement Reddit (concrete), LinkedIn/X/Instagram
   (to real shape, flagged untested).
7. Services: `engagement-reply.ts` (reply generator); `inbox.ts` (poll/metrics/orchestrator/queries/post);
   `automation.ts` `autoReplyEnabled` + reply cap note; `publications.ts` metrics on the list.
8. Routes: `routes/inbox.ts`; register in `app.ts`; extend the publications route with metrics; worker
   `inboxTick`.
9. Web: Inbox page + nav; auto-reply switch on Automation settings; metrics line on published posts;
   `engagement_reply` label in the TASK_LABELS maps.
10. Tests (`inbox.test.ts`) + contracts assertions; `npm test` + `npm run typecheck` green.
11. Deferred-improvements #12–17 + Sprint 29 acceptance section.
12. Commit to `sprint-29-engagement-reply-inbox`, push. **Do NOT merge into `main`.**

## Progress log
- 2026-06-22 — Branch `sprint-29-engagement-reply-inbox` created off `sprint-28-social-automation` (carries
  S25/26/27/28). Founder reframing: Sprint 29 is the **reply inbox** (A3), not discovery expansion (that's
  S31) — corrected a stale memory note. Founder decisions captured (asked first, 3 forks): new
  `publication_metrics` table; **configurable** auto-reply (per-workspace master switch × campaign mode);
  implement LinkedIn+X concretely (verified-when-creds), Reddit tested. Spec written.
- 2026-06-22 — Backend built (steps 3–8, 10): contracts (`engagement_reply` task type, inbox/metric vocab +
  schemas, `inboxRunResultSchema`, `autoReplyEnabled`); schema + migration `0022` (`inbox_items`,
  `publication_metrics`, `social_automation_settings.auto_reply_enabled`); resolver `conversation` layer +
  `engagement_reply` instructions; adapter read/reply methods (Reddit concrete; LinkedIn/X/Instagram to
  shape); `services/inbox.ts` (poll/metrics/orchestrator/post/queries) + `engagement-reply.ts` +
  `publications.ts` metrics-on-list + `automation.ts` `autoReplyEnabled`; `routes/inbox.ts` wired in
  `app.ts`; worker `inboxTick`. Tests `inbox.test.ts` (9) green. **Build paused mid step 9 (web).**
- 2026-06-23 — Resumed and finished. Step 9 web: new **Inbox page** (`app/workspaces/[id]/inbox/page.tsx`,
  nav link already present) — list/filter by status, Draft reply, Approve & post reply, Mark read / Dismiss,
  Run inbox now with run-result summary; engagement **metrics line** (24h/7d) added to the Create → Published
  panel; auto-reply master switch + `engagement_reply` TASK_LABELS were already in place. Fixed a strict-null
  typecheck error in `inbox.test.ts`. Step 11: deferred-improvements **#12–17** added (+ corrected the stale
  #11 trigger to S31); Sprint 29 **founder-acceptance** section appended. `npm test` + `npm run typecheck`
  green across all workspaces. Step 12: committed to `sprint-29-engagement-reply-inbox` and pushed. Not merged.
