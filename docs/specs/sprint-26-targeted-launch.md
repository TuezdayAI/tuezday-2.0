# Sprint 26 — Targeted campaign launch at a segment

> Phase B, item **C3 (part 2)** in `docs/plans/sprint-guide-21-onward.md`.
> **Branch:** `sprint-26-targeted-launch`. It needs *both* unmerged predecessors, so it was
> created off **`sprint-25-connect-social`** and then **`sprint-24-lead-lists-segments` was merged
> into it** (clean auto-merge; only `contracts/index.ts` + `founder-acceptance-tests.md` overlapped,
> both appends).
> **Required merge order into `main`:** `sprint-24-lead-lists-segments` → `sprint-25-connect-social`
> → `sprint-26-targeted-launch`. (If the founder merges 24 and 25 first, 26 merges cleanly after.)
> This spec stands alone: the founder resets the session between sprints.

## Goal

Launch a **personalized first-touch at a segment**, across email + social, with everything still
flowing through the brain resolver and the approval gate. One **launch** targets an audience (the
Sprint 24 segment/list) with optional campaign + persona context, then produces:

- **email** → one **per-recipient personalized** message per person in the pool → exported as a
  Smartlead/Instantly-ready **CSV** behind an `OutboundExporter` seam (live API push deferred — see
  `docs/deferred-improvements.md` #1).
- **LinkedIn + Instagram** → one approval-gated **broadcast post per platform** (their APIs forbid
  cold per-person DMs). **Instagram is built end-to-end for real** (founder decision 2026-06-22:
  he has the IG Business account + creds): caption + founder-supplied **media** (image / video-reel /
  carousel) published through the Facebook Graph API container→publish flow.
- **X (Twitter)** → a **per-recipient DM**, using a new editable **`xHandle`** stored on leads;
  recipients without a handle (incl. CRM contacts) are **skipped with a visible reason**; X's
  permission / rate-limit errors surface per recipient (never faked as success).

**Single first-touch only.** Multi-step follow-up sequences are Sprint 30.

## Founder decisions (captured 2026-06-21 in the roadmap, refined 2026-06-22 this session)

1. **Channel split** as above (email CSV; LinkedIn+IG broadcast; X per-recipient DM).
2. **Instagram = real, end-to-end this sprint.** Not a caption-only stub. The launch accepts
   founder-supplied media URLs (single image, a video/reel, or a 2–10 item carousel) and publishes
   via the Graph API. The *automatic generation* of that media (carousels/video) remains **Sprint 41**
   (design layer); Sprint 26 publishes media the founder provides. → Where the keys go: the IG OAuth
   app creds are the **Facebook app's `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET`** in the root
   `.env` (already wired in Sprint 25); connect on the Integrations page. The IG **Business account +
   linked Page** are discovered at publish time through the Graph API (`/me/accounts` →
   `instagram_business_account`) — no extra static key.
3. **X DMs = per-recipient, `xHandle` on leads** (recommended option). Handle-less people are skipped.
4. **Email = CSV export now** behind `OutboundExporter` (live Smartlead/Instantly API push deferred).
5. **Reuse, don't rebuild:** approval gate per message (existing `drafts`), publish pipeline for the
   broadcast posts (existing `publications`), resolver for every prompt. Never build
   sending/deliverability/warmup infra.

## What already exists (foundation — read before building)

- **People pool / audiences (S24, merged):** `loadPeople(db, ws)` and
  `resolveAudienceMembers(db, ws, audienceRow)` return a unified `Person { type, id, name, email,
  company, role }` from leads + unlinked CRM contacts. Static lists + dynamic segments. Audiences
  attach to campaigns. **We reuse `resolveAudienceMembers` as the launch's recipient source.**
- **Outbound (S11):** `/outbound/draft` already does the exact per-lead loop we mirror — resolve
  context with the `lead` slot → `llm.generate` → `storeGeneration` → `submitDraft` (lands in
  `pending_review`). `csvField()` + the `/outbound/export.csv` route show the CSV pattern.
- **Publishing (S17):** approved draft → `createPublication` → `attemptPublication` →
  `socialAdapterFor(fabric, provider, connection)` → `adapter.publishPost`. **Only Reddit has an
  adapter today**; `socialAdapterFor` returns `undefined` for everything else. `validateSocialPost` /
  `SOCIAL_POST_CONSTRAINTS` only know `reddit`.
- **Connections (S25):** `linkedin`, `twitter` (label "X (Twitter)"), `instagram` providers, all
  `oauth`/`["social"]`, with the posting/DM scopes already provisioned. Integration key per provider
  is `tuezday-${providerKey}` (so `tuezday-linkedin`, `tuezday-instagram`, `tuezday-twitter`).
- **Approval gate (S5):** `submitDraft` / `applyDraftAction` / the Review UI. `transitionTo`.
- **Resolver (brain):** `resolveContext(...)`. `CHANNEL_GUIDANCE: Record<Channel,string>` and
  `TASK_INSTRUCTIONS: Record<TaskType,string>` — adding a channel/task type is **compiler-enforced**
  to add a guidance entry. (NB: Sprint 21's DB-editable guidance is not on this branch; defaults live
  in the resolver, which is fine — we just add the new keys there.)

## Contracts (`packages/contracts/src/index.ts`)

Enum/vocabulary changes (contracts is the only place these live):

- **`CHANNELS`** += `"instagram"` → `["linkedin", "x", "email", "ads", "web", "pr", "instagram"]`.
  (Channel `"x"` already exists; note the channel↔provider name mismatch: channel `x` ↔ provider key
  `twitter`. Centralize the map — see services.)
- **`TASK_TYPES`** += `"instagram_post"`, `"x_dm"`.
- **`SOCIAL_POST_CONSTRAINTS`** += `linkedin` and `instagram`, and a `requiresMedia` flag:
  - `linkedin`: `{ targetLabel: "LinkedIn feed", titleMaxChars: 200, bodyMaxChars: 3000 }`.
  - `instagram`: `{ targetLabel: "Instagram", titleMaxChars: 0, bodyMaxChars: 2200, requiresMedia: true }`.
  - (reddit unchanged.) Add `requiresMedia?: boolean` to `SocialPostConstraints`. `validateSocialPost`
    keeps validating target/title/body; **media presence is validated in the launch service** (it has
    the media list), not in `validateSocialPost` (which has no media arg).
- **Launch domain:**
  - `LAUNCH_CHANNELS = ["email", "linkedin", "instagram", "x"]`, `LaunchChannel`. (Subset of channels
    a launch can drive — the broadcast/DM/export set.)
  - `LAUNCH_STATUSES = ["draft", "generating", "ready", "completed"]`, `LaunchStatus`.
  - `LAUNCH_MESSAGE_KINDS = ["personalized", "broadcast"]`.
  - `LAUNCH_MESSAGE_STATUSES = ["pending", "sent", "failed", "skipped"]` (dispatch lifecycle; approval
    is read from the linked draft's state).
  - `LAUNCH_MEDIA_TYPES = ["image", "video"]`; `launchMediaSchema = { url: z.string().url(), type }`.
  - `launchSchema`, `launchDetailSchema` (`{ launch, messages, recipientCount }`),
    `launchMessageSchema` (incl. resolved `draft: { id, state, content }`).
  - `createLaunchInputSchema` — `{ name, audienceId, campaignId?, personaId?, channels:
    LaunchChannel[] (min 1) }`.
  - `generateLaunchInputSchema` — `{ tokenBudget?, useEvidence? }`.
  - `dispatchChannelInputSchema` — `{ connectionId?, media?: LaunchMedia[] }` (media only meaningful
    for instagram; `connectionId` optional — auto-resolved when exactly one connected account of that
    platform exists, required otherwise).
- **Leads:** add `xHandle` to `leadSchema`, `createLeadInputSchema` (optional, normalized: strip a
  leading `@`, max 50), a new `updateLeadInputSchema` (all fields optional), and the CSV import header
  aliases (`x`, `twitter`, `x handle`, `twitter handle` → `xHandle`).
- **Person:** add optional `xHandle?: z.string()` to `personSchema`. `loadPeople` populates it for
  `lead` people; contacts leave it undefined. (Backward-compatible — S24 tests assert via the schema.)

## Data model (new tables → migration `0019`)

Edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api` → `0019_*.sql`. Keep
Postgres-portable (text ids, integer epoch-ms). Also add the `leads.xHandle` column here.

### `leads` (alter)
- `xHandle text NOT NULL DEFAULT ""` — the recipient's X handle (no leading `@`), editable.

### `launches`
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `name` | text NOT NULL | |
| `audienceId` | text → audiences (set null) | the target segment/list; recipients snapshot at generate time so a later delete is safe |
| `campaignId` | text → campaigns (set null) | context |
| `personaId` | text → personas (set null) | context |
| `channelsJson` | text NOT NULL | selected `LaunchChannel[]` |
| `status` | text NOT NULL default `draft` | `LaunchStatus` |
| `createdAt` / `updatedAt` | integer NOT NULL | |

### `launch_messages` (one per personalized recipient message, or per broadcast post)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `launchId` | text NOT NULL → launches (cascade) | |
| `channel` | text NOT NULL | `LaunchChannel` |
| `kind` | text NOT NULL | `personalized` \| `broadcast` |
| `recipientType` | text | `lead` \| `contact`, null for broadcast |
| `recipientId` | text | polymorphic lead/contact id, no FK; null for broadcast |
| `recipientName` / `recipientEmail` | text | snapshot for the CSV |
| `recipientHandle` | text | X handle snapshot; null when n/a |
| `draftId` | text NOT NULL → drafts (cascade) | the gated content |
| `status` | text NOT NULL default `pending` | `LaunchMessageStatus` (dispatch lifecycle) |
| `skipReason` | text | e.g. "No X handle on this lead." |
| `externalId` / `externalUrl` | text | platform post/DM id + url after dispatch |
| `publicationId` | text → publications (set null) | broadcast channels mirror into the publications list |
| `sentAt` | integer | |
| `lastError` | text | |
| `createdAt` / `updatedAt` | integer NOT NULL | |

Dedupe (one message per recipient+channel; one broadcast per channel) is enforced in the service, not
a partial unique index (SQLite treats nulls as distinct). Dangling polymorphic recipients are handled
by the snapshot columns — a deleted lead/contact never breaks the launch record.

## Services

### `apps/api/src/outbound/exporter.ts` — the email seam
```ts
export interface OutboundRecipientMessage {
  name: string; email: string; company: string; role: string; body: string;
}
export interface OutboundExporter {
  format: string;                       // "csv"
  export(messages: OutboundRecipientMessage[]): { filename: string; contentType: string; content: string };
}
export class CsvOutboundExporter implements OutboundExporter { /* Smartlead/Instantly-ready CSV */ }
```
Columns: `email,first_name,last_name,company,role,personalized_message` (the personalized body as a
custom variable — Smartlead/Instantly map columns to `{{variables}}`). `first_name`/`last_name` are a
best-effort split of `name`. Reuse `csvField()`. Injected via `buildApp` with `CsvOutboundExporter` as
the real default, so a future API-push impl swaps in without the launch domain changing.

### `apps/api/src/services/launches.ts`
Pure data + orchestration; provider calls go through the adapters/fabric only.
- `createLaunch` / `listLaunches` / `getLaunch` / `getLaunchDetail` / `deleteLaunch`.
- `LAUNCH_CHANNEL_PROVIDER: Record<LaunchChannel,string|null>` = `{ email:null, linkedin:"linkedin",
  instagram:"instagram", x:"twitter" }` — the channel↔provider map, single source.
- `generateLaunch(db, llm, evidence, ws, launchId, input, actor)`:
  - 409 if status !== `draft` (idempotency — regenerate = delete + recreate, keep it simple).
  - Set status `generating`. Resolve `recipients = resolveAudienceMembers(audience)`.
  - For each **personalized** channel in the launch (`email`, `x`):
    - For each recipient: resolve context (`taskType` `outbound_email`/`x_dm`, `channel` `email`/`x`,
      the recipient mapped into the resolver's `lead` slot {name,company,role,notes:""}, persona +
      campaign overlays, evidence per the outbound pattern) → `llm.generate` → `storeGeneration` →
      `submitDraft` → insert a `launch_message` (`kind:"personalized"`, recipient snapshot).
    - **X-specific:** if the recipient has no `xHandle` (every contact; leads without one), create the
      `launch_message` with `status:"skipped"`, `skipReason`, and **no draft/LLM call**.
  - For each **broadcast** channel (`linkedin`, `instagram`): one resolve (taskType `linkedin_post`/
    `instagram_post`, no recipient/lead slot; persona+campaign+audience-name context) → generate →
    submitDraft → one `launch_message` (`kind:"broadcast"`).
  - Set status `ready`.
- `exportLaunchEmail(db, exporter, ws, launchId)`: gather `email` messages whose **draft is approved**;
  build `OutboundRecipientMessage[]`; mark those messages `sent` (sentAt=now) — the CSV *is* the
  hand-off; return the exporter output. (Empty when none approved.)
- `dispatchChannel(db, fabric, fetcher, ws, launchId, channel, input, actor)` for
  `linkedin|instagram|x`:
  - Resolve the connection: the one connected account for `LAUNCH_CHANNEL_PROVIDER[channel]`; if
    several, require `input.connectionId`; 400 `no_connection`/`ambiguous_connection` otherwise.
  - **linkedin / instagram (broadcast):** take the broadcast message whose draft is approved; for IG
    require `input.media` (≥1, ≤10; a single `video` ⇒ reel; ≥2 ⇒ carousel) else 400
    `media_required`; call `createPublication(... , { media })` (extended — see below) which runs
    `attemptPublication` → the new adapter. On `published`: message `sent` + `publicationId` +
    `externalUrl`; on `failed`: message `failed` + `lastError`.
  - **x (per-recipient DM):** for each `x` message whose draft is approved and not skipped: resolve
    handle→id then send DM via the X adapter; record `sent`/`failed` + `externalId`/`lastError` per
    message. Sequential; one recipient's failure never aborts the rest.
  - When every selected channel is dispatched/exported, flip launch status to `completed`
    (best-effort; coarse — per-message status is the real detail).

### `services/publications.ts` (extend for media + non-Reddit broadcast)
- Add optional `media?: PublishMedia[]` to `createPublication` and persist it on a new nullable
  `publications.mediaJson` column (part of migration `0019`). `attemptPublication` passes
  `media` to `adapter.publishPost`. Reddit/LinkedIn ignore media; Instagram requires it.
- This means the **existing** `/drafts/:draftId/publish` route now also publishes LinkedIn (target
  `"feed"`, the adapter ignores it) as a free side-benefit. IG via that manual route would 400 without
  media — acceptable; launches are the media-carrying path.

### `services/leads.ts` (extend)
- `createLead`/CSV import carry `xHandle` (normalized, `@` stripped). Add `updateLead(db, ws, id,
  partial)` for editing `xHandle` (and the other fields). `loadPeople` already lives in audiences;
  update it to set `xHandle` for lead people.

## Connectors — new social adapters (`apps/api/src/connectors/social/`)

Extend the boundary in `index.ts`:
```ts
export interface PublishMedia { url: string; type: "image" | "video"; }
export interface SocialAdapter {
  publishPost(input: { target: string; title: string; body: string; media?: PublishMedia[] }): Promise<SocialPostResult>;
  sendDm?(input: { recipientHandle: string; body: string }): Promise<SocialPostResult>;
}
```
`socialAdapterFor` gains `linkedin` → `LinkedInAdapter`, `instagram` → `InstagramAdapter`,
`twitter` → `XAdapter` (all keyed by `tuezday-${provider.key}`). All calls go through
`fabric.proxyJson`.

- **`linkedin.ts`** — `publishPost`: read the member URN from `GET /v2/userinfo` (`sub` →
  `urn:li:person:{sub}`), then `POST /v2/ugcPosts` with author + `lifecycleState:"PUBLISHED"` +
  `shareCommentary:{text:body}` + `shareMediaCategory:"NONE"` + visibility `PUBLIC`. Post id from the
  `x-restli-id`/body id; url `https://www.linkedin.com/feed/update/{urn}`. Surface non-2xx + LinkedIn
  error bodies as `ConnectorFabricError` (like Reddit's in-band handling). (`w_member_social` =
  personal member feed; org-page posting needs a different scope — out of scope, noted.)
- **`instagram.ts`** — `publishPost({ body: caption, media })`: resolve the IG user id
  (`GET /v23.0/me/accounts?fields=instagram_business_account{id}` → first page's IG account; error
  with a clear message if none). Then:
  - single image → create container (`image_url`,`caption`) → `media_publish`.
  - single video → container (`media_type:"REELS"`,`video_url`,`caption`) → poll
    `GET {container}?fields=status_code` up to a bounded number of tries → `media_publish`; if still
    `IN_PROGRESS` after the bound, throw a clear "video still processing, retry" error (the existing
    publication **retry** route finishes it — no fake success).
  - carousel (≥2) → child containers (`is_carousel_item:true`) → parent (`media_type:"CAROUSEL"`,
    `children`,`caption`) → `media_publish`. url from the published media's `permalink`.
- **`x.ts`** — `sendDm({ recipientHandle, body })`: `GET /2/users/by/username/{handle}` → id, then
  `POST /2/dm_conversations/with/{id}/messages` `{ text: body }`. Return the dm event id; url null/empty.
  Map X's 403/429 (can't DM / rate limit) to a clear `ConnectorFabricError` so it lands on the
  message's `lastError`. (`publishPost` may throw "not supported" — X is DM-only this sprint.)

## API routes (`apps/api/src/routes/launches.ts` → `registerLaunchRoutes(app, db, llm, evidence, fabric, fetcher, exporter)`)

Thin; `workspaceOr404` like siblings; register in `app.ts` (add `exporter` to `buildApp` options with
the `CsvOutboundExporter` default; `server.ts` passes the same).

- `POST   /workspaces/:id/launches` (201) — create.
- `GET    /workspaces/:id/launches` — list (with recipient/message counts).
- `GET    /workspaces/:id/launches/:launchId` — detail (`{ launch, messages, recipientCount }`).
- `DELETE /workspaces/:id/launches/:launchId` (204).
- `POST   /workspaces/:id/launches/:launchId/generate` — generate drafts+messages (409 if not `draft`).
- `GET    /workspaces/:id/launches/:launchId/export.csv` — email exporter (marks exported messages
  `sent`); `content-disposition` attachment like the existing outbound export.
- `POST   /workspaces/:id/launches/:launchId/channels/:channel/dispatch` — linkedin|instagram|x.
- Lead editing for handles: `PATCH /workspaces/:id/leads/:leadId` — update lead (incl. `xHandle`).

Error vocabulary: `workspace_not_found`, `launch_not_found`, `audience_not_found`,
`campaign_not_found`, `persona_not_found`, `invalid_input`, `channel_not_selected` (409 dispatching a
channel the launch didn't include), `not_generated` (409 dispatch before generate), `media_required`
(400 IG without media), `no_connection` / `ambiguous_connection` (400), `lead_not_found`.

## Web (`apps/web`)

- **Nav:** add **"Launches"** (`/launches`) under the Audience/Campaigns group in
  `app/workspaces/[id]/layout.tsx`.
- **`app/workspaces/[id]/launches/page.tsx`:**
  - Create launch: name, pick an **audience** (with live member count), optional campaign + persona,
    pick **channels** (checkboxes: email / LinkedIn / Instagram / X) — disable a social channel when
    no such account is connected, with a hint.
  - **Generate** → show the launch detail: recipient count; per-channel sections.
  - Per message: recipient (or "Broadcast post"), the draft's state badge, a link to **Review**
    (reuse the existing approval UI) — plus an inline **Approve** convenience button calling the
    existing `POST /drafts/:id/approve`. Skipped X recipients show their reason.
  - Per-channel **dispatch** controls (enabled once that channel has ≥1 approved message):
    - email → **Download CSV** (the export route).
    - LinkedIn → **Post to LinkedIn** (pick account if >1) → shows sent + permalink.
    - Instagram → **media URL input(s)** (1 = image/video, 2–10 = carousel) + **Publish** → permalink.
    - X → **Send DMs** → per-recipient sent/failed/skipped list with errors.
- **Leads page:** add an **X handle** field on create + an inline edit (PATCH) so handles can be set;
  show it in the list. CSV import doc note: an `x`/`twitter` column maps to the handle.

## Boundary

- Reuse the **approval gate** (`drafts`) per message and the **publish pipeline** (`publications`) for
  broadcasts; reuse `resolveAudienceMembers` for recipients and the resolver for every prompt.
- **Never** build sending/deliverability/warmup infra. Email = CSV via `OutboundExporter` (live API
  push deferred — `deferred-improvements.md` #1). X DMs go through the official X API via Nango only.
- **Single first-touch only** — no follow-up steps, no scheduling cadence (Sprints 30 / 27).
- Tokens/secrets stay in `.env`/Nango, never in the DB, never logged.
- IG **media is founder-supplied**; auto-generating carousels/video is Sprint 41.

## Deferred-improvements entries to add

- **Launch generation is synchronous** (one LLM call per recipient inline, like S11 outbound). Fine
  for modest segments; the better version runs generation on the worker for large audiences.
- **IG video finalize via retry, not a worker poll** — bounded in-request poll; if a reel is still
  processing, the publication is left for the retry route. Better: worker-driven async finalize.
- (#1 email CSV→API already logged.)

## Tests (`apps/api/test/launches.test.ts` + a contracts assertion + adapter coverage)

`buildAuthedApp` + `createTestDb`; reuse the publish test's **fake `ConnectorFabric`** pattern (extend
its in-memory proxy to answer LinkedIn `/v2/ugcPosts` + `/v2/userinfo`, IG `/me/accounts` + `media` +
`media_publish` + status, and X `/2/users/by/username` + `/2/dm_conversations`). Fake LLM like S11.

1. **Contracts:** `instagram` channel; `instagram_post`/`x_dm` task types; `SOCIAL_POST_CONSTRAINTS`
   linkedin/instagram (+`requiresMedia`); `validateSocialPost` for them; the launch schemas;
   `leadSchema.xHandle`.
2. **Leads xHandle:** create + PATCH + CSV (`x`/`twitter` column) carry it; people pool exposes it for
   leads, not contacts.
3. **Launch CRUD:** create (audience must exist; channels non-empty), list counts, detail, delete;
   unknown → 404.
4. **Generate:** a static audience of N people + channels `[email, linkedin, instagram, x]` → N email
   messages + N x messages (handle-less ones `skipped`, no draft) + 1 linkedin + 1 instagram broadcast;
   all drafts in `pending_review`; 409 regenerating a non-draft launch.
5. **Gating:** dispatch/export only touch messages whose **draft is approved**; un-approved are
   skipped; dispatching a channel not selected → 409 `channel_not_selected`.
6. **Email export:** approve some email messages → `export.csv` returns a CSV with the personalized
   body column + marks them `sent`; uses the injected exporter.
7. **LinkedIn dispatch:** approve the broadcast → dispatch → message `sent`, `externalUrl` set, a
   `publications` receipt created.
8. **Instagram dispatch:** 400 `media_required` without media; with an image URL + fake fabric → `sent`
   (+ carousel path with 2 URLs).
9. **X dispatch:** approve the X messages → dispatch → handle recipients `sent`; a fabric-forced 403 →
   that recipient `failed` with the error, others still `sent`; skipped ones untouched.
10. **Connection resolution:** no connected account → 400 `no_connection`; two → 400
    `ambiguous_connection` unless `connectionId` given.
11. **Adapters (unit-ish via the fake fabric):** LinkedIn parses author/post id; IG runs
    container→publish (image + carousel); X resolves handle→id then posts the DM.

`npm test` + `npm run typecheck` green across all six workspaces.

## Founder acceptance (append to `docs/founder-acceptance-tests.md`)

With LinkedIn / X / Instagram connected (Sprint 25) and creds in `.env`, and a segment with a few
leads (some with X handles):
1. **Create a launch** at the segment, pick a campaign + persona, select all four channels.
2. **Generate** → see one personalized email + one X DM per recipient (handle-less leads/contacts
   show "skipped — no X handle"), plus one LinkedIn and one Instagram broadcast draft.
3. **Approve** the drafts (Review, or the inline approve).
4. **Email:** Download CSV → open it → personalized bodies + recipient columns present (ready to
   upload to Smartlead/Instantly).
5. **LinkedIn:** Post → the broadcast appears on the connected LinkedIn feed; the permalink resolves.
6. **Instagram:** paste an image URL (and try 2–3 for a carousel) → Publish → the post appears on the
   IG Business account.
7. **X:** Send DMs → recipients with a valid handle receive the DM; a bad/closed handle shows a clear
   per-recipient error; skipped recipients are untouched.

## Step plan

1. Spec (this file). ✅ (founder forks resolved: IG real end-to-end; X DM handle-on-leads)
2. Contracts: channels/task types/constraints/launch schemas/leads `xHandle`/Person `xHandle`.
3. Schema + migration `0019`: `leads.xHandle`, `publications.mediaJson`, `launches`, `launch_messages`.
4. Resolver: `instagram` channel guidance + `instagram_post`/`x_dm` task instructions.
5. `outbound/exporter.ts` (+ wire into `buildApp`/`server.ts`).
6. Adapters: linkedin / instagram / x; extend `SocialAdapter` + `socialAdapterFor`; extend
   `publications` for media.
7. `services/launches.ts` + `services/leads.ts` `updateLead`/`xHandle`; `loadPeople` xHandle.
8. Routes: `launches.ts` + lead PATCH; register in `app.ts`.
9. Web: Launches page + nav + leads X-handle field.
10. Tests (above) + contracts assertion; `npm test` + `npm run typecheck` green.
11. `docs/deferred-improvements.md` entries; Sprint 26 acceptance section in
    `docs/founder-acceptance-tests.md`.
12. Commit to `sprint-26-targeted-launch`, push. **Do NOT merge into `main`** (founder merges 24→25→26).

## Progress log

- 2026-06-22 — Branch created off `sprint-25-connect-social`; `sprint-24-lead-lists-segments` merged in
  (clean). Typecheck green on the merged base. Spec written. Founder forks resolved this session:
  **Instagram built real/end-to-end** (founder has the IG Business account + creds; media is
  founder-supplied, auto-generation stays S41); **X DMs per-recipient with `xHandle` on leads**.
  Implementation next.
- 2026-06-22 — **Built and verified green.** Implemented exactly to spec:
  - **Contracts** — `instagram` channel; `x_dm` + `instagram_post` task types; `SOCIAL_POST_CONSTRAINTS`
    for linkedin/instagram (+ `requiresMedia`); the full launch domain (statuses, message kinds/statuses,
    media, `launch`/`launchDetail`/`launchMessage` + create/generate/dispatch inputs); `leadSchema.xHandle`
    + `updateLeadInputSchema` + `xHandleSchema` (strips a leading `@`); optional `Person.xHandle`.
    Pinned-list tests in `contracts.test.ts` updated.
  - **Schema + migration `0019`** — `leads.x_handle`, `publications.media_json`, `launches`,
    `launch_messages`. (0018 was Sprint 24 — no collision.)
  - **Resolver** — `instagram` channel guidance + `x_dm`/`instagram_post` task instructions.
  - **`OutboundExporter` seam** (`outbound/exporter.ts`, `CsvOutboundExporter` default) wired into
    `buildApp`.
  - **Adapters** — `LinkedInAdapter` (member share via `/v2/ugcPosts`), `InstagramAdapter`
    (Graph container→publish: image / carousel / reel with bounded video poll), `XAdapter`
    (handle→id then DM). `SocialAdapter` gained optional media on `publishPost` + an optional `sendDm`;
    `socialAdapterFor` now routes all four social providers; `createPublication`/`attemptPublication`
    carry media.
  - **`services/launches.ts`** — create/list/detail/delete, `generateLaunch` (per-recipient email/X
    drafts, handle-less X recipients skipped with a reason, one broadcast draft per LinkedIn/IG),
    `exportLaunchEmail` (approved-only, marks sent), `dispatchChannel` (LinkedIn/IG broadcast via the
    publish pipeline + receipt; per-recipient X DMs; connection auto-resolution). `leads.updateLead` +
    `xHandle` through create/CSV; `loadPeople` exposes `xHandle` for leads.
  - **Routes** — `launches.ts` (create/list/detail/delete/generate/export.csv/dispatch) registered in
    `app.ts`; `PATCH /leads/:id`.
  - **Web** — Launches page (create → generate → per-channel review/approve + dispatch: CSV download,
    LinkedIn/IG publish with IG media inputs, X DMs), nav entry, leads X-handle field + inline edit.
    Task-label maps updated for the new task types.
  - **Tests** — `apps/api/test/launches.test.ts` (22 tests: contracts, the three adapters, and the full
    launch API incl. gating, CSV export, IG media requirement, X per-recipient send with a forced
    refusal, connection resolution, negatives).
  - **Verified:** full suite **572 passed (32 files)**; `npm run typecheck` clean across all six
    workspaces. `docs/deferred-improvements.md` entries #2 (sync generation) + #3 (IG video finalize)
    added; Sprint 26 acceptance section appended to `docs/founder-acceptance-tests.md`.
  - **Not merged into `main`** — founder merges 24 → 25 → 26 himself.
