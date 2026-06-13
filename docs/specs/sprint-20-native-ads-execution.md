# Spec: Sprint 20 — Native Ads Execution

> Status: draft
> Launch and manage ad campaigns from inside Tuezday — the last planned sprint, kept last deliberately: spending real money requires the approval gate *and* real user identity (Sprint 19). One platform: **Meta Ads**, the account already connected in Sprint 14. Spend flows through the same approve-before-act gate as everything else, with hard budget guardrails and a kill switch Tuezday enforces itself (never trusting the platform alone).

## What this slice does

1. **Ad launch object.** A new `ad_launches` table: a draft ad campaign assembled in Tuezday — name, objective, audience (countries + age range), daily budget, schedule, destination link, Facebook Page, and **one approved Sprint 15 Meta creative variant** (primary text / headline / description).
2. **Approval gate for spend.** A launch moves `draft → pending_review → approved` before any API call that can spend money. Decisions land in a new `ad_launch_decisions` log recording the acting user (`actor` + `actorId`, Sprint 19 identity). `revise` returns a pending/rejected/approved-but-unlaunched launch to `draft` for editing.
3. **Launch.** From `approved`, an explicit Launch call creates the Meta object chain through the connector fabric — campaign (created **PAUSED**) → ad set (budget, targeting, schedule) → ad creative (page + link + copy) → ad — and only then flips the campaign ACTIVE, so a partial failure never spends. External ids are persisted after each step; retrying a failed launch resumes from where it stopped instead of duplicating objects. A successful launch registers the new campaign in the Sprint 14 `ad_campaigns` mirror (linked to the Tuezday campaign the creative came from), so spend appears in existing reporting with zero new plumbing.
4. **Hard guardrails.** Per-workspace `ad_settings`: a **daily spend cap** (default **$50.00/day**) over the summed daily budgets of currently-spending Tuezday launches, and a **kill switch** that pauses every spending launch and blocks launch/resume while on. Per-campaign budget cap = the launch's own required daily budget (enforced by Meta) plus an optional end date. Caps are checked at the moments money can start flowing: launch and resume.
5. **Pause/resume + status sync.** Pause/resume a launched campaign from Tuezday (campaign-level status flip). The Sprint 14 sync job additionally pulls campaign `effective_status` per account and stamps it on launches (`platformStatus`), so platform-side pauses/disapprovals become visible in Tuezday.

Founder-visible chain: build a launch from an approved creative → submit → approve (decision log shows who) → Launch → campaign appears in Ads Manager with the set budget → pause from Tuezday works → spend shows up in the Sprint 14 ads report.

## Out of scope

Google Ads execution (lands behind the same boundary under integration expansion); image/video upload (v1 creatives are link ads — Meta scrapes the link preview image; media upload is a follow-up); lead-form and pixel-dependent objectives (`OUTCOME_LEADS`/`OUTCOME_SALES` need form/pixel setup — v1 objectives are **Traffic** and **Awareness**, which launch with just a Page + link); multiple ads per launch (one approved variant per launch; more ad sets/ads later); post-launch edits (budget/audience changes after launch — pause/kill only in v1); spend-based cap accounting (the cap counts *committed daily budgets*, which are deterministic and immediate — observed spend lags by hours); currency normalization (the cap is compared in integer cents across accounts regardless of currency — workspaces with mixed-currency ad accounts should set the cap conservatively); owner-only approval (any member can approve, same as drafts — role matrices are explicitly out per Sprint 19); launches in the Review page queue (review happens on the launch page in v1).

## Deployment

No new services. The Sprint 14 Meta connection must carry a token with **`ads_management`** (write) instead of `ads_read` — regenerate the system-user token with `ads_management` and reconnect. The system user needs access to the ad account *and* the Facebook Page the ads run as (Business settings → Pages → assign the system user; add `pages_read_engagement` to the token if creative creation complains). The Page ID is entered on the launch form (Page → About → Page ID).

## Behavior

### Contracts

- `AD_LAUNCH_STATUSES = ["draft", "pending_review", "approved", "rejected", "launched"]`; `AD_LAUNCH_ACTIONS = ["submit", "approve", "reject", "revise"]`; `adLaunchTransitionTo(from, action)` — the launch state machine, single source of truth:
  - `submit`: draft → pending_review
  - `approve`: pending_review → approved
  - `reject`: pending_review → rejected
  - `revise`: pending_review | rejected | approved → draft (an approved launch can be pulled back **until** it launches; `launched` is terminal in the approval machine — runtime state lives in `platformStatus`)
- `AD_LAUNCH_OBJECTIVES = ["OUTCOME_TRAFFIC", "OUTCOME_AWARENESS"]` + `AD_LAUNCH_OBJECTIVE_LABELS` (Traffic / Awareness).
- `adLaunchSchema`: id, workspaceId, adAccountId, campaignId (nullable — copied from the creative draft's campaign), creativeDraftId, name, objective, pageId, linkUrl, dailyBudgetCents (int ≥ 100), startAt/endAt (epoch ms, nullable), countries (array of 2-letter codes), ageMin/ageMax, status, externalCampaignId/externalAdSetId/externalCreativeId/externalAdId (nullable), adCampaignId (nullable — the Sprint 14 mirror row), platformStatus (nullable raw Meta `effective_status`), launchedAt/lastError (nullable), createdAt, updatedAt.
- `createAdLaunchInputSchema`: { adAccountId, creativeDraftId, name (1–100), objective, pageId (digits), linkUrl (https URL), dailyBudgetCents (100 ≤ n ≤ 100,000,000), startAt?, endAt?, countries (1–25 two-letter codes, uppercased), ageMin (18–65, default 18), ageMax (18–65, default 65) } with refinements ageMin ≤ ageMax and endAt > startAt (endAt > now when startAt is omitted).
- `updateAdLaunchInputSchema`: all of the above optional (draft-only edits, route revalidates references).
- `adSettingsSchema`: { workspaceId, dailyCapCents, killSwitch, updatedAt }; `updateAdSettingsInputSchema`: { dailyCapCents? (int ≥ 0), killSwitch? (boolean) }.
- `EVENT_TYPES` gains `ad.launched`.

### Schema (migration 0017)

- `ad_launches`: columns per `adLaunchSchema`; countries stored as `countries_json` text; FKs — workspace cascade, `ad_account_id` → ad_accounts cascade, `creative_draft_id` → drafts (no cascade — restrict by FK default), `campaign_id` → campaigns set null, `ad_campaign_id` → ad_campaigns set null.
- `ad_launch_decisions`: id, launchId (fk cascade), workspaceId (fk cascade), action, fromState, toState, actor, actorId (nullable), createdAt — the spend decision log, structurally identical to `approval_decisions`.
- `ad_settings`: workspaceId (pk, fk cascade), dailyCapCents (notNull default 5000), killSwitch (int boolean default 0), updatedAt. Read returns defaults when no row exists; write upserts.

### AdsExecutionAdapter (`apps/api/src/connectors/ads/`)

The Sprint 14 `AdsAdapter` stays read-only; execution is a separate capability the same Meta adapter implements:

```ts
interface AdsExecutionAdapter {
  createCampaign(externalAccountId, { name, objective }): Promise<{ externalId }>;      // created PAUSED, special_ad_categories: []
  createAdSet(externalAccountId, { campaignExternalId, name, dailyBudgetCents,
    objective, countries, ageMin, ageMax, startAt?, endAt? }): Promise<{ externalId }>; // status ACTIVE — campaign PAUSED gates it
  createAdCreative(externalAccountId, { name, pageId, linkUrl,
    primaryText, headline, description }): Promise<{ externalId }>;
  createAd(externalAccountId, { adSetExternalId, creativeExternalId, name }): Promise<{ externalId }>;
  setCampaignStatus(campaignExternalId, "ACTIVE" | "PAUSED"): Promise<void>;
  listCampaignStatuses(externalAccountId): Promise<Array<{ externalCampaignId, status }>>; // effective_status
}
```

`adsExecutionAdapterFor(fabric, provider, connection)` mirrors `adsAdapterFor`. Meta mapping (all POSTs via `proxyJson` with the pinned Graph base/version):

- Campaign: `POST /act_X/campaigns` `{ name, objective, status: "PAUSED", special_ad_categories: [] }`.
- Ad set: `POST /act_X/adsets` `{ name, campaign_id, daily_budget (minor units = our cents), billing_event: "IMPRESSIONS", optimization_goal: LINK_CLICKS (traffic) | REACH (awareness), targeting: { geo_locations: { countries }, age_min, age_max }, status: "ACTIVE", start_time?, end_time? (ISO) }`.
- Creative: `POST /act_X/adcreatives` `{ name, object_story_spec: { page_id, link_data: { link, message: primaryText, name: headline, description } } }`.
- Ad: `POST /act_X/ads` `{ name, adset_id, creative: { creative_id }, status: "ACTIVE" }`.
- Status flip: `POST /{campaignId}` `{ status }`. Statuses: `GET /act_X/campaigns?fields=effective_status&limit=200` (paged, capped).
- Non-2xx → `ConnectorFabricError` with status + body snippet, like every Sprint 14 call.

### Guardrail semantics (`apps/api/src/services/ad-launches.ts`)

- A launch is **spending** when `status = launched` and `platformStatus` is not one of PAUSED / CAMPAIGN_PAUSED / ARCHIVED / DELETED / DISAPPROVED (null counts as spending — benefit of the doubt goes to the cap).
- **Launch check** (and **resume check**): kill switch on → 409 `kill_switch_on`; `sum(dailyBudgetCents of spending launches) + this launch` > `dailyCapCents` → 409 `daily_cap_exceeded` with the amounts in the message.
- **Kill switch on** (PUT settings): every spending launch is paused via its adapter (best-effort per launch — failures recorded on the launch's `lastError`, reported in the response, never abort the rest), `platformStatus` → PAUSED.

### Endpoints (`apps/api/src/routes/ad-launches.ts`)

| Endpoint | Behavior |
|---|---|
| `GET /workspaces/:id/ads/settings` | settings (defaults when unset). |
| `PUT /workspaces/:id/ads/settings` | upsert cap/kill switch. Flipping killSwitch on returns `{ settings, paused: [{launchId, ok, error?}] }`. |
| `GET /workspaces/:id/ads/launches` | launches newest-first, each with `account {name, currency}` and a parsed creative preview. |
| `POST /workspaces/:id/ads/launches` | create (status `draft`). 404 unknown account/draft; 400 `account_not_launchable` (CSV account or connection missing/not connected); 400 `creative_not_meta` (taskType ≠ meta_ad_creative); 409 `creative_not_approved`; 400 `creative_unparseable`. `campaignId` is copied from the creative draft. |
| `GET /workspaces/:id/ads/launches/:launchId` | launch + decisions + creative fields. |
| `PATCH /workspaces/:id/ads/launches/:launchId` | edit — `draft` only (409 `not_editable`); reference changes revalidated like create. |
| `DELETE /workspaces/:id/ads/launches/:launchId` | any state except `launched` (409 `already_launched`). |
| `POST .../:launchId/submit` `/approve` `/reject` `/revise` | the state machine; illegal action → 409 `invalid_transition`. Every transition logs a decision with the Sprint 19 actor. |
| `POST .../:launchId/launch` | `approved` only (409 `launch_not_approved`; `launched` → 409 `already_launched`). Guardrails (above). Runs the object chain, persisting each external id as it lands; flips the campaign ACTIVE last. Success → status `launched`, `platformStatus: "ACTIVE"`, `launchedAt`, Sprint 14 `ad_campaigns` row created (linked to the launch's Tuezday campaign) + `adCampaignId` set, decision logged (action `launch` in the decisions log with the acting user), `ad.launched` emitted. Adapter failure → 502 `launch_failed`, `lastError` set, status stays `approved`, already-created ids kept — **retry resumes**, skipping completed steps. |
| `POST .../:launchId/pause` | `launched` + currently spending → flip PAUSED, `platformStatus: "PAUSED"`. 409 `not_launched` / `already_paused`. |
| `POST .../:launchId/resume` | `launched` + paused → guardrails re-checked (kill switch, cap counting this launch) → flip ACTIVE. |
| `POST /workspaces/:id/ads/sync` (existing) | after each account's metric pull, also `listCampaignStatuses` and stamp `platformStatus` on that account's launched launches (per-account best-effort — a status failure never blocks the metric sync). |

### Worker

No new jobs — status sync rides the existing `ADS_SYNC_HOURS` tick. **Bug fix shipped with this sprint:** `apps/worker/src/index.ts`'s `api()` helper recursed into itself instead of calling `fetch` (introduced in the Sprint 19 sweep), so every worker request stack-overflowed; fixed to call `fetch`.

### Web (`/workspaces/[id]/ad-launches`, nav child of Campaigns: "Launch ads")

- **Guardrails card**: daily cap (currency input), kill-switch toggle with a confirm step, committed-budget meter (sum of spending launches vs cap).
- **New launch form**: ad account select (connected accounts only), approved Meta creative select (grouped by campaign, shows the variant copy), name, objective, Page ID + destination link, daily budget, optional start/end, countries + age range.
- **Launch list**: status chip (approval status + platform status), budget, account, creative preview; actions per state — submit / approve / reject / revise / **Launch** / pause / resume / delete; decision log (who did what, when) on the expanded row; `lastError` surfaced with a Retry launch button.
- Approve and Launch are separate clicks by design — approval is the spend decision, launch is the trigger.

## Automated verification (`apps/api/test/ads-execution.test.ts`)

- Contracts: launch state machine transitions (legal + illegal), input schema bounds (budget min, age refinement, country codes, https link).
- Meta execution adapter (fixture Graph): campaign created PAUSED with `special_ad_categories`; ad set carries budget in cents, billing event, optimization goal per objective, targeting and schedule mapping; creative `object_story_spec` shape; ad references adset + creative; activation flips the campaign last; statuses listing; non-2xx → `ConnectorFabricError`.
- API (fake fabric): create validations (CSV account 400, unapproved creative 409, non-Meta task type 400); gate flow draft→pending→approved with decisions recording actor + actorId; revise pulls an approved launch back; PATCH draft-only; DELETE blocked after launch; launch happy path (object chain order, external ids + ad_campaigns mirror row + Tuezday campaign link, `ad.launched` emitted, launch decision logged); launch blocked unapproved / by kill switch / by daily cap; paused launches don't count toward the cap; mid-chain failure → 502 + partial ids persisted + retry skips completed steps; pause/resume incl. resume re-checking guardrails; settings defaults + upsert; kill switch pauses all spending launches; `/ads/sync` stamps platformStatus and survives a status-listing failure.

## Founder acceptance checklist

1. Reconnect Meta Ads with an `ads_management` system-user token (Page assigned to the system user).
2. Ads settings: set a daily cap you're comfortable with (default $50/day).
3. Generate + approve a Meta creative variant (Sprint 15 flow) if none exists.
4. Launch ads page → New launch → pick account + approved creative, Traffic objective, your Page ID + a landing URL, a small daily budget (e.g. $2), your countries → Create.
5. Submit → Approve (note the decision log records you) → **Launch**.
6. Campaign appears in Ads Manager: correct name, PAUSED-then-ACTIVE history, daily budget, targeting; ad preview shows your approved copy.
7. Pause from Tuezday → Ads Manager shows it paused; Resume → active again.
8. Try a second launch whose budget would blow the cap → blocked with a clear message.
9. Flip the kill switch → the live campaign pauses; launching anything is blocked until it's off.
10. After the next sync (or Sync now on the Ads page), spend from the launched campaign appears in the Sprint 14 report under the linked Tuezday campaign.
