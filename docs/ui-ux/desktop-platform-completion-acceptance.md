# Desktop platform completion acceptance

## Scope

This acceptance closes the desktop platform-completion sprint. Supported QA widths are 1024, 1280,
1440, and 1728 pixels. Mobile visual QA is intentionally out of scope for this desktop application.

## Automated desktop evidence

Run `npm run test:desktop`. Chromium exercises an authenticated deterministic fixture without a live
API, persistent database writes, or third-party effects. Each run captures diagnostic screenshots in
`test-results/desktop`.

| Surface | Automated assertion |
| --- | --- |
| Command Center | Ranked action is visible at all four widths; standard actions are at least 40px high; no horizontal overflow. |
| Review authorization batch | Selection creates an immutable preview; the dialog fits a 1280×900 viewport; confirmation preserves a partial failure and recovery link. |
| Action permissions | Workspace, connection, and persona editors render from deterministic effective-policy data. Campaign and active-lane mounting are enforced by their focused Vitest contracts. |
| Native sender | Verified address, sender form, action sizing, and DNS record state render without overflow. |
| Meta mutation | Provider state opens the budget-diff editor and keeps its guarded proposal action at least 40px high. |
| Native email | An explicitly allowed recipient can trigger the governed send and see the accepted delivery receipt. |

## Interaction and hierarchy acceptance

- Compact controls are at least 36px high; standard controls are at least 40px high.
- Decision regions expose one clear filled primary action. Destructive alternatives use the danger
  hierarchy and non-decision navigation uses secondary or tertiary actions.
- Buttons retain their width while showing the built-in loading indicator.
- Dialog content stays inside the desktop viewport and remains closable with Escape.
- Focusable controls use semantic buttons, links, form controls, and labelled regions; the acceptance
  suite locates them by role and accessible name rather than styling hooks.
- The supported desktop documents do not create page-level horizontal scrolling. Dense tables keep
  any necessary overflow inside their local wrapper.

## Policy-editor inventory

The action-policy hierarchy is one workspace default, optional campaign overrides, and
tightening-only persona, connection, and active-lane rules.

- Workspace: `/automation`, concrete human-required or autonomous defaults.
- Campaign: campaign Overview, inherit or override for each action kind.
- Persona: Context inspector, shown only while editing that persona.
- Connection: Integrations account detail, shown only for the expanded account.
- Active lane revision: campaign Channels, tightening only; immutable plan content remains separate.

The shared editor exposes inherited effective status and contributing rules so a stricter upstream
constraint is never mistaken for a failed save.

## Release gate

Before merging or releasing, all of the following must pass from a clean checkout:

```sh
npm test
npm run typecheck
npm run test:desktop
npm run build -w apps/web
```

Playwright traces, videos, and screenshots are run artifacts, not committed baselines.

## Delivered API and persistence record

- Meta mutation routes: `POST /workspaces/:id/ads/launches/:launchId/budget-change` and
  `POST /workspaces/:id/ads/launches/:launchId/targeting-change`, backed by revalidated
  `MetaAdsAdapter` reads and writes.
- Batch routes: create a fixed preview at `POST /workspaces/:id/external-action-batches`, read it at
  `GET /workspaces/:id/external-action-batches/:batchId`, and confirm/resume it at
  `POST /workspaces/:id/external-action-batches/:batchId/authorize`.
- Sender routes: `GET|PUT /workspaces/:id/email-sender`, plus `/verify` and `/refresh` actions.
- Recipient safety: `GET|PUT /workspaces/:id/email-permissions/:normalizedEmail`,
  `GET|PUT /workspaces/:id/email-safety`, and signed public `GET|POST /u/:token` unsubscribe.
- Delivery ingestion: `POST /webhooks/resend` verifies the untouched raw request body before storing
  an event or projecting delivery/suppression state.
- Native send origins: Launch channel dispatch, approved Audience drafts, and approved PR pitch drafts
  all enter the external-action coordinator and the `ResendOutboundEmailProvider` adapter.
- Migration 0046 adds `external_action_batches` and `external_action_batch_items`.
- Migration 0047 adds `workspace_email_senders`, `email_recipient_permissions`,
  `email_suppressions`, `email_deliveries`, and `email_delivery_events`.

## Fresh final evidence — 2026-07-16

- `npm test`: 162 files and 1,520 tests passed.
- `npm run typecheck`: all seven workspaces passed.
- `npm run build -w apps/web`: optimized Next.js production build passed.
- `npm run test:desktop`: 10 Chromium scenarios passed at the four supported widths and the
  representative authorization, policy, sender, Meta mutation, and delivery surfaces.
- Fresh migration: 48 migrations applied; all seven 0046/0047 tables existed and were empty.
- Populated pre-0046 reconstruction: rows in `leads`, `media_contacts`, `connections`,
  `external_actions`, `launches`, and `ad_launches` were identical after upgrade; all new tables were
  empty; the permission default was `unknown`; the sender default was `not_configured` with its kill
  switch enabled; SQLite foreign-key checks passed.

## Explicit deferrals

- Google Ads mutation execution and Meta targeting broader than country/age.
- SMTP or additional native outbound providers beyond Resend.
- Mobile visual QA; desktop widths below 1024px are outside this acceptance.
- Batch content approval; the delivered batch flow authorizes external actions only.
- Distributed queue infrastructure; bounded and resumable single-process ledgers are retained.
