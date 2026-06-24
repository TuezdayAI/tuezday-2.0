# Sprint 27 — Recurring cadence, campaign calendar + transactional mailer

> Phase C, item **A6 (scheduling)** + the **shared transactional mailer** in
> `docs/plans/sprint-guide-21-onward.md`.
> **Branch:** `sprint-27-cadence-calendar-mailer`, created off **`main`**.
> **Builds on:** Sprint 17 (publications + the publish worker), Sprint 7 (campaigns),
> Sprint 5 (approval gate) — **all already on `main`**, so this sprint is **independent of the
> unmerged Sprints 21–26** and needs no predecessor merge. (It collides only on the migration
> *number* `0018` with the parallel Sprints 23/24 branches; the founder merges one branch at a time
> and renumbers if needed, per the workflow.)
> This spec stands alone: the founder resets the session between sprints.

## Goal

Three things, all reusing existing seams rather than building new infra:

1. **Recurring posting cadence.** A workspace defines recurring posting **slots** (days-of-week +
   time-of-day + IANA timezone) bound to a campaign + channel + a connected social account + a target.
   **Approved** drafts that match (campaign + channel, optionally persona) **auto-fill** the next open
   slots — each fill creates a **scheduled `publication`** (Sprint 17), so the existing publish worker
   fires it on time. No new sending infra; the cadence is a *scheduler on top of publications*.
2. **Workspace-wide calendar.** One "what's going out when" surface: scheduled + published + failed
   publications **and** upcoming empty cadence slots in a date window, filterable by campaign/channel.
3. **Transactional mailer (Resend) behind an interface.** A `Mailer` seam with a **ConsoleMailer**
   default (no key needed in dev/tests) and a **ResendMailer** impl. Wire the one existing gap —
   **workspace invite emails** (Sprint 19 left invites link-only) — plus a `/mail/test` send endpoint.
   Later sprints (email approvals S39, billing S37) reuse the same seam.

**Founder acceptance (roadmap):** "Define a weekly cadence → drafts auto-slot → appear on a calendar
→ publishing fires on schedule; a test transactional email sends."

## Founder decisions (captured this session, 2026-06-22)

1. **Cadence model = campaign + channel auto-fill** (recommended option). A cadence binds a
   **campaign + channel + connected account + target + recurrence**; approved drafts in that
   campaign/channel auto-fill the next open slots as **scheduled publications**, reusing the Sprint 17
   pipeline + worker. (Alternatives — manual slot placement, persona-only — declined.)
2. **Mailer scope = interface + Resend + wire invites** (recommended). ConsoleMailer default,
   ResendMailer impl, real invite emails wired, `/mail/test` endpoint. (Infra-only declined.)
3. **Calendar = workspace-wide, all sources** (recommended): publications + upcoming empty cadence
   slots, filter by campaign/channel. (Cadence-scoped-only declined.)

## What already exists (foundation — read before building)

- **Publications (S17, `services/publications.ts`):** `createPublication(db, fabric, fetcher, ws,
  draftId, connection, input)` inserts a receipt; a **future `scheduledFor` stays `scheduled`** for the
  worker, otherwise it publishes synchronously. `attemptPublication` fires one receipt
  (`socialAdapterFor(fabric, provider, connection).publishPost({target,title,body})`), records
  `published`+url / `failed`+lastError, emits `post.published`. `runDuePublications` fires every
  `scheduled` row with `scheduledFor <= now`. **We reuse all of this unchanged** — cadence fill just
  creates `scheduled` rows at slot times. Only adapter on `main` is **Reddit**; LinkedIn/X/Instagram
  adapters arrive when Sprints 25/26 merge — the cadence is provider-agnostic and lights up for them
  automatically (it goes through `socialAdapterFor`).
- **Worker (`apps/worker/src/index.ts`):** ticks for discovery, learning, ads, and **publish**
  (`publishTick` → `POST /workspaces/:id/publish/run` every `PUBLISH_INTERVAL_MIN`). We add a
  **`cadenceTick`** that calls a new fill endpoint; the existing publishTick then fires what it queued.
- **Approval gate (S5):** `listDrafts(db, ws, state?, campaignId?)` already filters by state +
  campaign. We pull `listDrafts(db, ws, "approved", campaignId)` and filter by channel/persona.
- **Connections (`services/connections.ts`):** `listConnections`, `getConnection`, `providerByKey`.
  A social connection = `provider.categories?.includes("social")` + `status === "connected"`.
- **Campaigns (S7), Personas (S2):** `getCampaign`, `getPersona` for create-time validation + context.
- **Teams/invites (S19, `routes/teams.ts` + `services/teams.ts`):** `createInvite` returns a row with a
  `token`; **no email is sent today** — the admin shares the link manually. We add the email.
- **`buildApp` composition root (`apps/api/src/app.ts`):** every external dep is an injectable option
  with a real default; tests inject fakes. We add a `mailer?` option (env-driven default) and register
  the cadence + mail routes; **`server.ts` needs no change** (defaults read env).

## Contracts (`packages/contracts/src/index.ts`)

Additive only — no existing vocabulary changes.

- **Cadence domain:**
  - `CADENCE_STATUSES = ["active", "paused"]`, `CadenceStatus`.
  - `WEEKDAYS` helper: integers `0..6`, **Sunday = 0** (matches JS `Date.getUTCDay()`).
  - `timeOfDaySchema` — `z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)")`.
  - `timeZoneSchema` — `z.string().min(1).refine(isValidTimeZone, "Unknown time zone")`, where
    `isValidTimeZone(tz)` tries `new Intl.DateTimeFormat("en-US",{timeZone:tz})` in a try/catch
    (works in Node + browser; no date library).
  - `postingCadenceSchema` — `{ id, workspaceId, name, campaignId (uuid nullable), personaId (uuid
    nullable), channel: enum(CHANNELS), connectionId (uuid), target, daysOfWeek: int[0..6][],
    timeOfDay, timezone, status: enum(CADENCE_STATUSES), createdAt, updatedAt }`.
  - `createPostingCadenceInputSchema` — `{ name (1..120), campaignId (uuid), personaId (uuid optional),
    channel: enum(CHANNELS), connectionId (uuid), target (1..200), daysOfWeek: int[0..6] min1 (deduped),
    timeOfDay, timezone, status: default "active" }`. (campaignId **required** at input — the cadence
    targets a campaign — though the column is nullable so a later campaign delete sets-null + pauses.)
  - `updatePostingCadenceInputSchema` — all fields `.partial()` (incl. `status` for pause/resume).
- **Calendar:**
  - `CALENDAR_ENTRY_STATUSES = ["open", "scheduled", "published", "failed"]` (`open` = empty slot).
  - `calendarEntrySchema` — `{ kind: "slot"|"publication", at: int(epoch ms), cadenceId nullable,
    cadenceName nullable, channel nullable, providerKey nullable, status: enum(above), title,
    draftId nullable, publicationId nullable, url nullable }`.
- **Publications (extend):** add `cadenceId: z.string().uuid().nullable()` to `publicationSchema`
  (additive; `publish.test.ts` asserts via the schema so the field must be present and nullable).
- **Mail:**
  - `mailResultSchema` — `{ delivered: z.boolean(), id: z.string().nullable(), detail: z.string() }`.
  - `sendTestMailInputSchema` — `{ to: z.string().email() }`.

## Data model (migration `0018`, off main's `0017`)

Edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api`. Postgres-portable (text ids,
integer epoch-ms). **Two changes** — keep `CREATE TABLE posting_cadences` ordered before the
`publications.cadence_id` ALTER in the generated SQL (the FK references it); reorder by hand only if
generation emits them backwards.

### `posting_cadences` (new)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `name` | text NOT NULL | |
| `campaignId` | text → campaigns (set null) | matching + context; null ⇒ effectively paused (can't match) |
| `personaId` | text → personas (set null) | optional matching filter + context overlay |
| `channel` | text NOT NULL | a `Channel`; matches the draft's channel |
| `connectionId` | text NOT NULL → connections (cascade) | the social account fills publish through |
| `target` | text NOT NULL | destination (subreddit; `feed` for LinkedIn — adapter ignores) |
| `daysOfWeekJson` | text NOT NULL | JSON `number[]` (0–6, Sun=0) |
| `timeOfDay` | text NOT NULL | `HH:MM` 24h, interpreted in `timezone` |
| `timezone` | text NOT NULL | IANA tz id |
| `status` | text NOT NULL default `active` | `CadenceStatus` |
| `createdAt` / `updatedAt` | integer NOT NULL | |

### `publications` (alter)
- `cadenceId text REFERENCES posting_cadences(id) ON DELETE SET NULL` (nullable). Manual S17 publishes
  leave it null; cadence-filled rows carry it (calendar grouping + dedupe + delete-cancel).

## Services

### `apps/api/src/mail/mailer.ts` — the transactional-email seam
```ts
export interface MailMessage { to: string; subject: string; text: string; html?: string; }
export interface MailResult { delivered: boolean; id: string | null; detail: string; }
export interface Mailer { send(message: MailMessage): Promise<MailResult>; }

export class ConsoleMailer implements Mailer { /* logs; delivered:true, id:null */ }
export class ResendMailer implements Mailer {
  // POST https://api.resend.com/emails  Authorization: Bearer RESEND_API_KEY
  // body { from: MAIL_FROM, to, subject, text, html? }; non-2xx ⇒ delivered:false + detail.
  constructor(apiKey: string, from: string, fetcher: typeof fetch) {}
}
/** Real default: Resend when RESEND_API_KEY + MAIL_FROM are set, else Console. */
export function createDefaultMailer(fetcher: typeof fetch): Mailer { ... }
```
Console default means tests/dev never need a key and never hit the network. `ResendMailer` uses the
**injected fetcher** (tests record the request).

### `apps/api/src/services/cadences.ts` — cadence CRUD + slot math + fill
Pure data + slot computation; the only platform calls go through `createPublication` (→ adapters).

- **Slot math (tz-correct, no date library):**
  - `localParts(tz, ms)` → `{ year, month, day, weekday }` via `Intl.DateTimeFormat` parts +
    `new Date(Date.UTC(y,m-1,d)).getUTCDay()` for the weekday.
  - `zonedWallClockToUtc(y, mo, d, h, mi, tz)` → epoch ms, using the standard offset-derivation
    (guess wall-time as UTC, subtract the tz offset at that instant, refine once for DST). Document the
    rare DST-gap wall-time edge case as a deferred improvement.
  - `slotsBetween(cadence, fromMs, toMs)` → `number[]`: walk the window in **12h steps** (well under any
    DST day length), process each distinct local date once (dedupe by `Y-M-D`), and for dates whose
    weekday ∈ `daysOfWeek` compute the slot instant; keep those in `(fromMs, toMs]`. Sorted, deduped.
- **CRUD:** `createCadence` (validates campaign + connection exist, connection is social + connected,
  persona exists when given), `listCadences`, `getCadence`, `updateCadence` (re-validates changed
  refs), `deleteCadence` (first **delete this cadence's still-`scheduled` publications** so removing a
  cadence never leaves orphan auto-posts; published history stays, its `cadenceId` set null by the FK).
- **`eligibleDrafts(db, ws, cadence)`** — `listDrafts(db, ws, "approved", cadence.campaignId)` filtered
  by `channel === cadence.channel` and (if set) `personaId === cadence.personaId`, **excluding** drafts
  that already have a live (`scheduled`/`published`) publication for this cadence. Oldest-approved first
  (FIFO queue).
- **`fillCadence(db, fabric, fetcher, ws, cadence, nowMs)`** → `{ filled: number }`:
  - Skip if `status !== "active"` or `campaignId == null`.
  - `slots = slotsBetween(cadence, nowMs, nowMs + CADENCE_HORIZON_DAYS*86400_000)` (default **14 days**).
  - Drop slots already taken by a `scheduled`/`published` publication of this cadence (match on
    `cadenceId` + `scheduledFor`).
  - Pair open slots with `eligibleDrafts` in order; for each pair `createPublication(... , {
    connectionId, target: cadence.target, title: deriveTitle(draft.content), scheduledFor: slot },
    cadenceId)`. Future `scheduledFor` ⇒ the row stays `scheduled` (worker fires it).
  - `deriveTitle(content)` = first non-empty line, trimmed/collapsed, capped at 300 (Reddit's title
    limit; LinkedIn/X/IG adapters ignore the title). Cadence does **not** pre-validate via
    `validateSocialPost` — an invalid post simply fails its receipt at fire time with the platform error
    (the existing failed-receipt path), and a derived title covers the common Reddit case.
- **`fillActiveCadences(db, fabric, fetcher, ws, nowMs)`** — fill every `active` cadence; returns
  `[{ cadenceId, filled }]` (worker entry).
- **`getCadenceDetail`** — cadence + next K upcoming slots (computed) + its filled publications +
  `queuedCount` (eligibleDrafts length).
- **`createPublication` extension:** add a trailing optional `cadenceId?: string | null` param,
  persisted on the row (default null). `rowToPublication` already spreads the row, so `cadenceId`
  flows into the `Publication` once the column + schema field exist.

### `services/calendar.ts` — `buildCalendar(db, ws, fromMs, toMs)`
- `publications` in `[from,to]` by `scheduledFor` (any status) → `kind:"publication"` entries
  (status = the publication status; `at = scheduledFor`; title from publication/draft; url; cadence
  name via a join on `posting_cadences`).
- For every **active** cadence: `slotsBetween(cadence, from, to)` minus the timestamps already covered
  by that cadence's publications → `kind:"slot"` entries with `status:"open"`.
- Return `{ entries }` sorted by `at`. (Workspace-wide; the web filters by campaign/channel client-side
  using the cadence/channel fields.)

## API routes

### `apps/api/src/routes/cadences.ts` → `registerCadenceRoutes(app, db, connectors, fetcher)`
Thin; `workspaceOr404` like siblings; register in `app.ts`.
- `POST   /workspaces/:id/cadences` (201) — create.
- `GET    /workspaces/:id/cadences` — list (each with `queuedCount` + `nextSlotAt`).
- `GET    /workspaces/:id/cadences/:cadenceId` — detail.
- `PATCH  /workspaces/:id/cadences/:cadenceId` — update / pause / resume.
- `DELETE /workspaces/:id/cadences/:cadenceId` (204) — delete (+ cancel its scheduled publications).
- `POST   /workspaces/:id/cadences/:cadenceId/fill` — fill now → `{ filled }` + detail.
- `POST   /workspaces/:id/cadences/run` — fill all active cadences (worker entry) → `{ results }`.
- `GET    /workspaces/:id/calendar?from=&to=` — calendar entries (defaults: from=now, to=now+14d;
  clamp the window to ≤ 92 days so slot computation stays bounded).

Error vocabulary: `workspace_not_found`, `cadence_not_found`, `campaign_not_found`,
`persona_not_found`, `connection_not_found`, `not_social` (connection isn't a connected social
account), `invalid_input`.

### `apps/api/src/routes/mail.ts` → `registerMailRoutes(app, db, mailer)`
- `POST /workspaces/:id/mail/test` — body `{ to }` → `mailer.send(...)` a fixed test message →
  return the `MailResult` (200). Proves the seam end-to-end.

### Invite emails (`routes/teams.ts` → `registerTeamRoutes(app, db, mailer)`)
After a successful `createInvite`, **best-effort** `mailer.send({ to: invite.email, subject: "You're
invited to <workspace> on Tuezday", text/html with the link `${APP_BASE_URL}/invites/${token}` })`.
A mailer failure is caught + logged and **never fails invite creation** (the response still returns the
invite incl. token, so the existing link-sharing flow keeps working). `APP_BASE_URL` env, fallback
`http://localhost:3000`.

## `buildApp` wiring (`apps/api/src/app.ts`)
- Add `mailer?: Mailer` to `BuildAppOptions`, default `createDefaultMailer(fetcher)`.
- `registerTeamRoutes(app, db, mailer)` (was `(app, db)`).
- `registerCadenceRoutes(app, db, connectors, fetcher)`.
- `registerMailRoutes(app, db, mailer)`.
- `server.ts`: unchanged (mailer default reads `RESEND_API_KEY`/`MAIL_FROM` from env).

## Worker (`apps/worker/src/index.ts`)
Add `cadenceTick` (`CADENCE_FILL_INTERVAL_MIN`, default **5**): `POST /workspaces/:id/cadences/run`
for every workspace; log `{ cadence, filled }` totals, stay quiet when nothing filled. Runs **before**
the existing `publishTick` so newly-slotted-due rows fire the same minute. Same resilience pattern
(per-workspace try/catch; one failure never aborts the loop).

## Web (`apps/web`)
- **Nav** (`app/workspaces/[id]/layout.tsx`): add a top-level **"Calendar"** (`/calendar`) with a child
  **"Cadence"** (`/cadence`).
- **`app/workspaces/[id]/cadence/page.tsx`:** list cadences (name, campaign, channel, account, target,
  schedule summary "Mon/Wed/Fri 09:00 America/New_York", status, `queuedCount`, `nextSlotAt`); create
  form (name, campaign select, optional persona, channel, **connected social account** select [disabled
  with a hint when none], target, day-of-week checkboxes, time, timezone [default the browser's
  `Intl.DateTimeFormat().resolvedOptions().timeZone`]); **Pause/Resume**, **Fill now**, **Delete**.
- **`app/workspaces/[id]/calendar/page.tsx`:** a **7-day week grid** (Mon–Sun columns), prev/next week
  nav, entries per day: publications (status chip + platform + link when published) and **open** cadence
  slots ("— open —"); a campaign/channel filter. Fetches `GET /calendar?from=&to=` for the visible week.
- **Team page** (`app/workspaces/[id]/team/page.tsx`): a small **"Send test email"** control (to an
  address) hitting `/mail/test`, and a note that inviting a teammate now emails them the link.

## Boundary
- **Reuse, don't rebuild:** cadence fill creates **scheduled `publication`** rows and leans entirely on
  the Sprint 17 publish pipeline + worker; only **approved** drafts are ever slotted (the gate already
  cleared them). Never build sending/deliverability/warmup infra.
- **Mailer is integrate-behind-an-interface** (Resend), Console default; no templating engine, no
  delivery tracking table this sprint.
- The **per-campaign automation MODE** (manual / human-in-the-loop / scheduled-auto) and discovery→
  content mapping are **Sprint 28** — not here. Multi-step sequences are Sprint 30. This sprint is the
  cadence/calendar/scheduler **primitive** + the mailer.
- Secrets (`RESEND_API_KEY`, OAuth) stay in `.env`/Nango, never in the DB, never logged.

## Deployment (founder step for the mailer)
Optional this sprint (Console default works without it): create a Resend API key + a verified sender,
put `RESEND_API_KEY` and `MAIL_FROM` (e.g. `Tuezday <noreply@yourdomain>`) and `APP_BASE_URL` in the
root `.env`, restart the API. Without them, invite/test emails log to the API console (delivered:true,
id:null) so the flow is still demoable.

## Deferred-improvements entries to add (create `docs/deferred-improvements.md`)
1. **Cadence fill is synchronous on a worker tick**, bounded to a 14-day horizon; large fan-out / sub-
   minute precision would want a dedicated scheduler.
2. **DST-gap wall-clock times** (the ~1h/year that doesn't exist locally) resolve to the adjacent valid
   instant rather than being skipped/flagged.
3. **Cadence doesn't pre-validate posts** (`validateSocialPost`) at fill time — an invalid post fails
   its receipt at fire time; the derived title covers the common Reddit case. A pre-flight check could
   surface problems before the slot fires.
4. **Mailer has no delivery tracking / retries / templating** — fire-and-log behind the interface;
   bounce/open tracking + a real template layer come with the email-approvals/billing sprints.

## Tests (`apps/api/test/cadences.test.ts` + `apps/api/test/mail.test.ts`)
`buildAuthedApp` + `createTestDb`; reuse `publish.test.ts`'s **fake `ConnectorFabric` + Reddit** and its
`connectReddit()` / `approvedDraft()` helpers (an approved draft = generate → submit → approve). Use
`vi.useFakeTimers()` + `vi.setSystemTime(new Date("2026-07-06T08:00:00Z"))` (a **Monday**) so slot
timestamps are deterministic.

**cadences.test.ts**
1. **Contracts:** `createPostingCadenceInputSchema` accepts a valid cadence; rejects bad `timeOfDay`
   (`9:5`, `24:00`), out-of-range `daysOfWeek` (`7`), unknown `timezone`; `calendarEntrySchema` /
   `postingCadenceSchema` round-trip; `publicationSchema` now carries nullable `cadenceId`.
2. **Slot math via the calendar:** a cadence Mon/Wed/Fri 09:00 `America/New_York`, no drafts →
   `GET /calendar?from&to` over a 7-day window returns **3 open slots**, each at 13:00Z or 14:00Z
   (EDT = UTC−4 in July) on the right weekday.
3. **CRUD + validation:** create (400 `campaign_not_found` / `connection_not_found` / `not_social`
   for a non-social or disconnected connection / `persona_not_found`); list (`queuedCount`,
   `nextSlotAt`); get; patch (pause → status `paused`); delete unknown → 404.
4. **Fill:** campaign with **3 approved matching drafts** + a Mon/Wed/Fri cadence → `POST .../fill` →
   3 `scheduled` publications at the next 3 slots, each `cadenceId` set, draft linked, title = draft's
   first line. Non-approved, wrong-channel, wrong-campaign, and (with a persona-scoped cadence)
   wrong-persona drafts are **not** slotted. **Idempotent** — a second fill creates 0 more. A `paused`
   cadence fills 0.
5. **Firing reuses S17:** set a cadence slot a few minutes ahead, fill (→ scheduled), advance
   `vi.setSystemTime` past the slot, `POST /publish/run` → the row publishes via the fake Reddit fabric
   (`published` + url), `post.published` recorded.
6. **Delete cancels its scheduled posts:** fill, then `DELETE` the cadence → its `scheduled`
   publications are gone (no orphan auto-post), any `published` ones remain.

**mail.test.ts**
7. **`/mail/test`** with a **fake Mailer** capturing sends → `delivered:true`, one captured message to
   the address.
8. **Invite emails:** `POST /workspaces/:id/invites` → an invite email is captured (to = invitee,
   subject names the workspace, body contains `/invites/<token>`); invite creation **still 201s when
   `mailer.send` throws** (best-effort).
9. **ConsoleMailer** returns `delivered:true,id:null`; **ResendMailer** (with a recording fetcher)
   POSTs `https://api.resend.com/emails` with `Authorization: Bearer <key>` + `from/to/subject`, maps a
   non-2xx to `delivered:false` + detail.

`npm test` + `npm run typecheck` green across all workspaces.

## Founder acceptance (append to `docs/founder-acceptance-tests.md`)
With Reddit connected (Sprint 17) — LinkedIn/X/Instagram light up the same way once those adapters
merge — and a campaign with a few **approved** drafts:
1. **Cadence → New cadence:** name it, pick the campaign + channel, pick the connected Reddit account,
   target `r/test`, check Mon/Wed/Fri, time `09:00`, your timezone → **Create** → it lists with a
   queued-draft count and the next slot time.
2. **Fill now** → the matching approved drafts auto-slot; **Calendar** shows them on the right days/times
   as `scheduled`, with the remaining open slots marked "— open —".
3. Wait for (or force) a slot to come due → the worker publishes it to Reddit; the calendar entry flips
   to `published` with a working link (same receipt you already see on the Content page).
4. **Pause** the cadence → no new slots fill; **Resume** → filling continues. **Delete** → its still-
   scheduled posts are canceled (nothing unexpected goes out).
5. **Team → Send test email** to yourself → it arrives (or, without a Resend key, logs to the API
   console as delivered). **Invite a teammate** → they receive the invite link by email.

## Step plan
1. Spec (this file). ✅
2. Contracts: cadence domain, calendar entry, `publicationSchema.cadenceId`, mail schemas + helpers.
3. Schema + migration `0018`: `posting_cadences`, `publications.cadence_id`.
4. Mailer seam (`mail/mailer.ts`): Console + Resend + `createDefaultMailer`.
5. Cadence service (slot math + CRUD + fill) + calendar service; extend `createPublication` w/ cadenceId.
6. Routes: `cadences.ts`, `mail.ts`; wire invite email into `teams.ts`; register all in `app.ts`.
7. Worker: `cadenceTick`.
8. Web: Calendar page, Cadence page, nav, Team test-email control.
9. Tests (`cadences.test.ts`, `mail.test.ts`) + contracts assertions; `npm test` + `npm run typecheck`.
10. `docs/deferred-improvements.md` (new) + Sprint 27 section in `docs/founder-acceptance-tests.md`.
11. Commit to `sprint-27-cadence-calendar-mailer`, push. **Do NOT merge into `main`.**

## Progress log
- 2026-06-22 — Branch `sprint-27-cadence-calendar-mailer` created off `main` (independent of unmerged
  21–26; migration `0018` off main's `0017`). Founder decisions captured (campaign+channel auto-fill;
  Resend+invites; workspace-wide calendar). Spec written. Implementation next.
- 2026-06-22 — **Built and verified green.** Implemented to spec:
  - **Contracts** — cadence domain (`CADENCE_STATUSES`, `postingCadenceSchema`, create/update inputs,
    `WEEKDAY_LABELS`, `isValidTimeZone`, HH:MM + tz validation, deduped/sorted `daysOfWeek`); calendar
    (`CALENDAR_ENTRY_STATUSES`, `calendarEntrySchema`); `publicationSchema.cadenceId` (nullable); mail
    (`mailResultSchema`, `sendTestMailInputSchema`). Pinned publication fixture in `contracts.test.ts`
    updated with `cadenceId: null`.
  - **Schema + migration `0018`** — `posting_cadences` table + `publications.cadence_id`
    (`ON DELETE SET NULL`, hand-fixed on the generated ALTER since drizzle-kit omits it).
  - **Mailer seam** (`mail/mailer.ts`) — `Mailer` + `ConsoleMailer` (default) + `ResendMailer` +
    `createDefaultMailer` (Resend when `RESEND_API_KEY`+`MAIL_FROM`, else Console) + `appBaseUrl`.
  - **Cadence service** (`services/cadences.ts`) — tz-correct slot math (`slotsBetween` via Intl, no
    date lib), CRUD, `eligibleDrafts`, `fillCadence`/`fillActiveCadences`, list/detail views;
    `createPublication` extended with a `cadenceId`; `listCadencePublications` added.
  - **Calendar service** (`services/calendar.ts`) — publications + open cadence slots in a window.
  - **Routes** — `cadences.ts` (CRUD/fill/run/calendar), `mail.ts` (`/mail/test`); invite emails wired
    into `teams.ts` (best-effort); all registered in `app.ts` with a `mailer` build option.
  - **Worker** — `cadenceTick` (`CADENCE_FILL_INTERVAL_MIN`, default 5) fills active cadences; the
    existing 1-min publish tick fires due rows.
  - **Web** — Calendar page (7-day grid + filters), Cadence page (create/fill/pause/delete), nav entry,
    Team test-email control + updated invite copy; new CSS.
  - **Tests** — `cadences.test.ts` (11) + `mail.test.ts` (7): contracts, CRUD/validation, slot math via
    the calendar, fill (matching/persona/idempotency/paused), end-to-end firing via `publish/run`,
    delete-cancels-scheduled; mailer seam + invite email + best-effort + Console/Resend units.
  - **Verified:** full suite **536 passed (31 files)**; `npm run typecheck` clean across all six
    workspaces. `docs/deferred-improvements.md` created (#1–#4) + Sprint 27 acceptance section appended.
  - **Not merged into `main`** — founder reviews + merges.
