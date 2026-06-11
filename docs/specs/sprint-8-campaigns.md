# Spec: Sprint 8 — Campaigns

> Status: in build
> Covers Phase 6 of the rebuild plan, milestone M6. Campaigns make GTM goal-scoped rather than one-off, and fill the resolver's campaign slot (empty by design since Sprint 3).

## What this slice does

The founder creates a campaign — objective, KPI, timeframe, audience slice, messaging pillars, channels, personas, and a free-form `now` overlay. Selecting a campaign when resolving/generating injects a composed campaign section into the context bundle, visibly changing output. Every generation and draft created under a campaign is tagged to it, and the campaign view shows its drafts grouped by approval state (the first campaign-scoped report).

## Out of scope

Campaign-driven scheduling/automation, campaign assignment of discovered items (discovery triage stays workspace-level for now), engagement metrics (learning loop sprint), multi-campaign resolution (one campaign per task).

## Behavior

### Campaign object (contracts)

`{ id, workspaceId, name (1–200), objective (≤1000), kpi (≤500), timeframe (≤200, free text), audience (≤1000), pillars (string[] ≤10 × ≤200), channels (Channel[]), personaIds (uuid[]), overlay (markdown ≤10,000 — the campaign's "now"), status: active | archived, createdAt, updatedAt }`. Only `name` is required to create; everything else can grow as the campaign firms up.

### Resolver integration

The campaign section content is **composed deterministically** from the campaign's fields (objective / KPI / timeframe / audience / pillars / overlay, labeled, empty fields omitted) by the API service, then passed through the existing `resolveContext` campaign slot — the brain package stays unchanged. The section reason names the campaign. No campaign selected → slot stays excluded exactly as before.

`resolveRequestSchema` (and therefore generate) and `draftSignalRequestSchema` gain optional `campaignId`. Unknown/archived campaign → `404` / `409 campaign_archived`.

### Tagging

`generations` and `drafts` gain nullable `campaignId`. Generate-with-campaign tags the generation; submitting it to the queue carries the tag onto the draft; drafting from a signal with a campaign tags both. `GET /drafts?campaignId=` filters.

### API

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/campaigns` | `201` campaign |
| `GET /workspaces/:id/campaigns` | list, active first then newest |
| `GET /workspaces/:id/campaigns/:campaignId` | campaign + draft counts by state + draft summaries (the campaign report v0) |
| `PUT /workspaces/:id/campaigns/:campaignId` | full replace (including status — archive/unarchive) |

### Web

- `/workspaces/[id]/campaigns`: list with status badges and per-campaign draft-state counts; create/edit form (pillars as one-per-line textarea, channel checkboxes, persona checkboxes, overlay textarea); archive/unarchive.
- Campaign picker (active campaigns only) added to: resolver page, sandbox, and the content page's draft-response controls.
- Draft cards in the approval queue show a campaign badge when tagged.

## Automated verification

- Contracts: campaign input validation (name required, limits, channel/persona shapes).
- API: CRUD + archive; resolve with campaign includes a composed section (objective + pillars + overlay present, campaign named in reason) and without stays excluded; archived campaign refused; generate/submit/signal-draft all carry `campaignId` end-to-end; drafts filter by campaign; campaign detail counts correct; 404s.

## Founder acceptance checklist (M6 gate)

1. Create a campaign with a real objective, pillars, and a `now` overlay.
2. Resolve the same task with and without the campaign — the bundle visibly changes and the trace says why.
3. Generate + approve a draft under the campaign; draft a signal response under it too.
4. Open the campaign: both drafts are there, counted by state.
5. Archive it — it leaves the pickers but its history stays readable.
