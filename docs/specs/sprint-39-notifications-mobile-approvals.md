# Sprint 39 — Notifications & mobile approvals: Telegram + email

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** A1 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 39"
- **Branch:** `sprint-39-notifications-mobile-approvals`, cut from `main`
- **Merge order:** none. "Builds on: Sprint 5 (approval gate), Sprint 27 (mailer)" — both on `main` (verified: `apps/api/src/services/drafts.ts` with the `submit/edit/resubmit/approve/reject` state machine + `applyDraftAction`; `apps/api/src/mail/mailer.ts`). `main` HEAD is Sprint 31; Sprints 34/35/36/37/38 unmerged and not dependencies.
- **Size:** M.
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

> **For agentic workers:** self-contained spec. Strict TDD. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Goal

Let the founder **approve / reject from their phone** the moment a draft hits the gate — via a Telegram message with inline buttons, and a one-click email link.

Founder acceptance (from the roadmap):

> Draft hits the gate → Telegram message with approve/reject → tap approve → state changes; the email link works once.

---

## Decisions locked (recommended defaults)

1. **Notify on the gate transition, at the route choke point.** A draft "hits the gate" when it enters `pending_review` — i.e. on `submit` and `resubmit`. The draft routes are where these happen (`apps/api/src/routes/drafts.ts`, the `submit`/`resubmit` actions, plus `draftForGeneration`→submit from the sandbox). Call a single `notifyDraftPending(...)` there. Notifications are **best-effort and never block/fail** the transition (same contract as `emitEvent`).
2. **Action links are signed, one-time, expiring tokens — not session-bound.** A phone tap can't carry a bearer token, so each approve/reject link embeds an HMAC-signed token (`draftId | action | exp`, signed with `NOTIFY_SIGNING_SECRET`) recorded in an `approval_action_tokens` table and **burned on first use** (`usedAt`). The action endpoint is **public** (allowlisted) but token-gated. Expired/used/invalid → a friendly "link no longer valid" page.
3. **Telegram via the Bot API over REST, no SDK** (`sendMessage` with an inline keyboard; `answerCallbackQuery`). The bot token lives in env. Telegram inline taps arrive at a public `POST /telegram/webhook` that maps `callback_query` data (`approve:<token>` / `reject:<token>`) to the same burn-once action path.
4. **Email via the Sprint 27 `Mailer`** (Console default in dev) with two big buttons linking to the public action endpoint.
5. **Per-workspace channel config** (`notification_channels`): a Telegram channel (chat id) and/or an email channel (address), each toggleable. No channel configured ⇒ no notification (and the bot/mailer being unconfigured degrades gracefully).
6. **Re-use the existing draft state machine** — the action endpoint and Telegram webhook both call `applyDraftAction(db, draft, action, actor, …)`; an illegal transition (already decided) returns a clear "already handled" message. The actor for remote actions is labelled (e.g. `"telegram"` / `"email-link"`) with `userId: null`.

---

## Out of scope (YAGNI)
- Editing draft content from Telegram/email (approve/reject only; "edit" stays in-app).
- Slack/SMS/push channels (Telegram + email only).
- Threaded conversation / chat with the bot beyond the approve/reject callbacks.
- Digest/batching of notifications (one message per pending draft in v1).
- Web test runner.

---

## Architecture & boundary

```
drafts route (submit/resubmit → pending_review)
  └─ notifyDraftPending(db, mailer, fetcher, draft) ─┬─ Telegram sendMessage (inline approve/reject)
                                                     └─ Mailer.send (approve/reject buttons)
        each button/link carries an HMAC token (burned once)

Email button  → GET  /a/:token            (public) → applyDraftAction → result page
Telegram tap  → POST /telegram/webhook     (public) → callback_query → applyDraftAction → answerCallbackQuery
Config        → /workspaces/:id/notifications  CRUD (session-guarded)
```

- **Native (owned):** the approval gate + the signed-action protocol. **Integrated behind a boundary:** Telegram (only in `apps/api/src/notifications/telegram.ts`) and email (the `Mailer`), both via injected `fetcher`/`mailer`.

### New files
- `apps/api/src/notifications/telegram.ts` — `sendApprovalMessage`, `answerCallback` (REST, injected fetcher); `TelegramError`.
- `apps/api/src/notifications/tokens.ts` — `mintActionToken`, `verifyAndBurn` (HMAC + table burn).
- `apps/api/src/services/notifications.ts` — channel CRUD + `notifyDraftPending`.
- `apps/api/src/routes/notifications.ts` — channel config CRUD; public `GET /a/:token`; public `POST /telegram/webhook`.
- Tests: `apps/api/test/notifications.test.ts`, `apps/api/test/notification-tokens.test.ts`.

### Modified files
- `packages/contracts/src/index.ts` — `NOTIFICATION_CHANNEL_TYPES`, channel schemas.
- `apps/api/src/db/schema.ts` — `notification_channels`, `approval_action_tokens`.
- `apps/api/drizzle/00NN_notifications.sql` — generated (next after `0022` on `main`; renumber on collision).
- `apps/api/src/app.ts` — `registerNotificationRoutes(app, db, mailer, fetcher)`; pass `mailer`/`fetcher` into `registerDraftRoutes` so it can call `notifyDraftPending` (drafts route already receives `fetcher`).
- `apps/api/src/auth/guard.ts` — add `GET /a/:token` and `POST /telegram/webhook` to `PUBLIC_ROUTES`.
- `apps/api/src/routes/drafts.ts` — call `notifyDraftPending` after a `submit`/`resubmit` succeeds (and on the sandbox→submit path).
- `.env.example` — `TELEGRAM_BOT_TOKEN`, `NOTIFY_SIGNING_SECRET`, `APP_BASE_URL`.

---

## Data model

```ts
// apps/api/src/db/schema.ts
export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // "telegram" | "email"
  target: text("target").notNull(),      // telegram chat id | email address
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const approvalActionTokens = sqliteTable("approval_action_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),     // sha256 of the raw token
  workspaceId: text("workspace_id").notNull(),
  draftId: text("draft_id").notNull(),
  action: text("action").notNull(),            // "approve" | "reject"
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("approval_action_tokens_hash").on(t.tokenHash)]);
```

```ts
// packages/contracts/src/index.ts
export const NOTIFICATION_CHANNEL_TYPES = ["telegram", "email"] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];
export const createNotificationChannelInputSchema = z.object({
  type: z.enum(NOTIFICATION_CHANNEL_TYPES),
  target: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});
```

---

## Implementation plan (TDD, bite-sized)

> Baseline: `git checkout main && git pull`, `npm install`, `npm test`, `git checkout -b sprint-39-notifications-mobile-approvals`.

### Task 1: Channel contracts + schema
- [ ] **Test** (`packages/contracts/test/notifications.test.ts`): channel types enumerate `telegram`/`email`; input schema rejects an empty target.
- [ ] **Implement** the enum + schemas; add the two tables; `npm run db:generate`. Run `npm test -w @tuezday/api` (migration applies). **Commit:** `feat: notification channels + action-token schema`.

### Task 2: Signed one-time action tokens
- [ ] **Test** (`apps/api/test/notification-tokens.test.ts`): `mintActionToken` returns a raw token + persists its hash; `verifyAndBurn` accepts a fresh token once (returns `{draftId, action, workspaceId}`), then **rejects the second use** (`used`), rejects an expired token, rejects a tampered/unknown token.
- [ ] **Run red** → implement `apps/api/src/notifications/tokens.ts`:

```typescript
import { createHash, createHmac, randomBytes } from "node:crypto";
// raw token = base64url(`${draftId}.${action}.${exp}.${hmac}`); store sha256(raw).
export function mintActionToken(db: Db, workspaceId: string, draftId: string, action: "approve" | "reject", ttlMs = 7 * 864e5): string { /* … */ }
export function verifyAndBurn(db: Db, raw: string): { workspaceId: string; draftId: string; action: "approve" | "reject" } | { error: "invalid" | "expired" | "used" } { /* sha256 lookup → check exp → check usedAt → set usedAt atomically */ }
```

- [ ] **Run green. Commit:** `feat(api): signed one-time approval action tokens`.

### Task 3: Telegram client + notifications service
- [ ] **Test** (`apps/api/test/notifications.test.ts`, part 1, fixture fetcher): `sendApprovalMessage` POSTs to `https://api.telegram.org/bot<token>/sendMessage` with `chat_id` + an inline keyboard whose `callback_data` is `approve:<token>` / `reject:<token>`; unconfigured bot → no-op (no throw). `notifyDraftPending` sends to each enabled channel (Telegram via client, email via a fake `Mailer`) and never throws.
- [ ] **Run red** → implement `notifications/telegram.ts` + `services/notifications.ts` (`notifyDraftPending(db, mailer, fetcher, draft)` mints a token per action, builds links `${APP_BASE_URL}/a/<token>`, and fans out to channels).
- [ ] **Run green. Commit:** `feat(api): Telegram client + notifyDraftPending`.

### Task 4: Fire notifications on the gate + public action endpoint
- [ ] **Test** (part 2): submitting a draft (sandbox→submit) triggers `notifyDraftPending` (assert via a fake mailer/fetcher capturing sends); `GET /a/:token` for an approve token transitions the draft to `approved` and shows a success page; reusing the link shows "already used"; an `approve` token for an already-approved draft shows "already handled" (caught `InvalidTransitionError`).
- [ ] **Run red** → wire `notifyDraftPending` into `routes/drafts.ts` after `submit`/`resubmit` succeed; add `GET /a/:token` (public): `verifyAndBurn` → load draft → `applyDraftAction(db, draft, action, { userId: null, label: "email-link" })` → HTML result page. Add the route to `PUBLIC_ROUTES`.
- [ ] **Run green. Commit:** `feat(api): notify on gate + one-time email approval links`.

### Task 5: Telegram webhook
- [ ] **Test** (part 3): `POST /telegram/webhook` with a `callback_query` `{ data: "approve:<token>" }` approves the draft and calls `answerCallbackQuery`; an invalid/used token answers with a friendly toast and does not transition.
- [ ] **Run red** → add `POST /telegram/webhook` (public) handling `callback_query`: parse `action:token` → `verifyAndBurn` → `applyDraftAction` → `answerCallback`. (Optional shared-secret on the webhook path via Telegram's `secret_token` header — note in Known limitations.)
- [ ] **Run green** + full `npm test`. **Commit:** `feat(api): Telegram approve/reject webhook`.

### Task 6: Config UI + env
- [ ] Channel CRUD routes (`/workspaces/:id/notifications`) + a settings page: add/enable/disable a Telegram chat id and an email address; a "send test" button.
- [ ] Append `TELEGRAM_BOT_TOKEN`, `NOTIFY_SIGNING_SECRET`, `APP_BASE_URL` to `.env.example` (notes: create a bot via @BotFather; set the webhook to `${APP_BASE_URL}/telegram/webhook`).
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`; `npm test && npm run typecheck` green. **Commit:** `feat(web): notification channel settings + docs`. Then `git push -u origin sprint-39-notifications-mobile-approvals` (**do not merge**).

---

## Automated verification
- Contracts: channel enum + input.
- Tokens: mint/verify/burn-once/expiry/tamper.
- Telegram client (fixture fetcher): request shape + inline keyboard; unconfigured no-op.
- Service/routes: notify fires on submit/resubmit; email link approves once then "used"; illegal transition handled; Telegram webhook approves + answers.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] Configure a Telegram chat + email channel. Generate → submit a draft to the gate.
- [ ] A Telegram message arrives with Approve/Reject buttons → tap Approve → the draft is approved in-app; the button tap shows a confirmation toast.
- [ ] The email arrives with Approve/Reject links → the link works **once**; a second click says the link is no longer valid.

## Known limitations
- Approve/reject only (no remote edit).
- One message per pending draft (no batching/digest).
- Telegram webhook authenticity relies on the unguessable bot path + optional `secret_token` header; harden with Telegram's `setWebhook secret_token` if exposed publicly.
- Action tokens default to a 7-day TTL.

## Progress log
- 2026-06-26 — Spec drafted against `main` (HEAD Sprint 31). Verified reuse points: draft state machine `applyDraftAction` + `APPROVAL_ACTIONS = [submit,edit,resubmit,approve,reject]` + `transitionTo` (`services/drafts.ts`, `contracts`), `Mailer`/`ConsoleMailer` (`mail/mailer.ts`), `auth/guard.ts` `PUBLIC_ROUTES`, drafts route action loop (`routes/drafts.ts`). Highest migration on `main` = `0022_rich_bloodstorm.sql`. Branch not yet cut (awaiting founder go-ahead).
