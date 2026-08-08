# Persona Account Routing Design

> Status: ready for founder review
> Date: 2026-06-27

## Problem

Tuezday's social pipeline is supposed to let a workspace connect multiple social accounts and route work through the right account for the persona being used. The current implementation does not model that.

The current system has three structural gaps:

1. `connections` are workspace-level and the service logic effectively treats one provider as one connection. `registerOAuthConnection` and `connectProvider` look up an existing row by `workspaceId + providerKey` and replace it.
2. Personas influence generation only. A persona has `name`, `description`, and `overlay`; it has no durable relationship to LinkedIn, Instagram, X, Reddit, or any other platform account.
3. Publishing, cadences, launches, inbox polling, metrics, and guardrails all operate on `connectionId`, but there is no policy layer that says which persona may use which `connectionId`.

This creates a serious safety issue: a CEO persona draft, a company page draft, and a founder-alt draft can all be published through the wrong real-world account.

## Decision

Use a many-to-many persona-account assignment model with a primary account flag.

One persona can be assigned multiple accounts across providers. One social account can be shared by multiple personas when the founder intentionally configures it that way. For each persona and social channel, one assignment can be marked primary. Automated flows use the primary assignment unless an explicit, valid account override is supplied.

## Approaches Considered

### Approach A: Put account IDs directly on `personas`

Example: store a JSON map such as `{ linkedin: connectionId, instagram: connectionId }` on each persona.

This is fast, but it is too rigid. It cannot cleanly support multiple accounts per persona on the same provider, account sharing, primary vs secondary accounts, account-level labels, or audit-friendly joins from publications back to a persona-account assignment.

### Approach B: Add a `persona_social_accounts` join table

Example: `persona_social_accounts(personaId, connectionId, providerKey, channel, isPrimary, defaultTarget)`.

This is the recommended approach. It keeps tokens and health state in `connections`, keeps identity and routing policy in the join table, and does not require rewriting publishing, inbox, metrics, or guardrails around a new account abstraction.

### Approach C: Introduce a first-class `social_accounts` aggregate above `connections`

Example: `social_accounts` owns identity, provider, labels, page/member metadata, and one or more backing connector connections.

This is cleaner long-term for platforms with sub-assets such as Facebook Pages and LinkedIn organizations, but it is too much for the current problem. It would force a larger connector rewrite before the product can safely route persona posts.

## Recommended Architecture

### Source Of Truth

`connections` remains the source of truth for provider credentials, connector health, Nango connection IDs, and platform identity metadata.

`persona_social_accounts` becomes the source of truth for which persona may use which social account for which social channel.

`publications`, `posting_cadences`, `launch_messages`, `inbox_items`, guardrails, and metrics continue to use `connectionId` as their operational link. This keeps the existing pipeline intact while adding routing policy before any dispatch decision.

### Data Model

Add identity metadata to `connections`:

- `displayName`: user-facing account label, for example `Ananya - LinkedIn` or `Tuezday Company Page`.
- `externalAccountId`: provider account or member ID, when the test endpoint exposes it.
- `externalAccountName`: provider display name, when available.
- `externalAccountHandle`: provider handle or username, when available.
- `externalAccountUrl`: profile/page URL, when available.
- `updatedAt`: timestamp for label and identity refreshes.

Add `persona_social_accounts`:

- `id`
- `workspaceId`
- `personaId`
- `connectionId`
- `providerKey`
- `channel`
- `isPrimary`
- `defaultTarget`
- `createdAt`
- `updatedAt`

Use service-level enforcement for "one primary per persona + provider + channel" because portable partial unique indexes are awkward across SQLite now and Postgres later.

### Connection Semantics

Connecting another LinkedIn account must create another `connections` row. It must not overwrite the existing LinkedIn connection.

OAuth completion becomes idempotent by Nango connection ID:

- If `workspaceId + nangoConnectionId` already exists, update and return that row.
- Otherwise create a new row, even when another row already exists for the same provider.

Token-paste and no-auth connections also use unique connection IDs per account rather than `ws-${workspaceId}-${providerKey}`.

The Integrations page changes from "one card has one connection" to "one provider has zero or more connected accounts."

### Routing Rules

The routing service owns all account selection decisions:

`resolvePersonaSocialConnection(db, workspaceId, { personaId, channel, providerKey, explicitConnectionId })`

Rules:

1. If an explicit `connectionId` is provided and the draft or launch has no persona, accept any connected social connection for that provider.
2. If an explicit `connectionId` is provided and a persona exists, accept it only when that connection is assigned to the persona for the provider/channel.
3. If no explicit `connectionId` is provided and a persona exists, use the primary assignment for that persona and provider/channel.
4. If no primary assignment exists, return `persona_account_missing`.
5. If the assigned connection is disconnected or unhealthy, return `persona_account_unavailable`.
6. If service data somehow has two primary assignments, return `persona_account_ambiguous` and do not post.

Manual publishing still lets a user pick an account, but the picker only shows accounts assigned to the draft persona. Persona-less drafts can use any connected social account.

Automated publishing never guesses from "the only LinkedIn account." It either resolves the persona's primary account or blocks.

### Pipeline Changes

Manual publish:

- Draft with no persona: current behavior remains; pick any connected social account.
- Draft with persona: selected connection must be assigned to that persona for the target provider/channel.

Cadence:

- Cadence creation can accept `connectionId` explicitly.
- If a cadence has `personaId` and no `connectionId`, it resolves the persona's primary account for the cadence channel.
- Existing cadence rows keep a concrete `connectionId` so scheduled publications are stable and auditable.

Launch dispatch:

- LinkedIn and Instagram broadcast dispatch use the launch persona's primary account when no connection override is provided.
- X DMs use the launch persona's primary X account when no `xConnectionId` override is provided.
- If the persona is missing a required channel account, the launch channel is blocked before any platform call.

Sequences:

- Sequence X DMs use `launch.xConnectionId` only as an explicit override.
- If it is null, the sequence runner resolves the launch persona's primary X account.
- If a recipient replies, inbox and stop-on-reply behavior still keys off the final `connectionId`.

Inbox and metrics:

- Polling continues per connection.
- UI can show which personas are assigned to the account, but inbox storage does not need a persona foreign key.

Guardrails:

- Per-connection caps remain per connection.
- Per-campaign caps remain per campaign.
- The persona mapping does not weaken guardrails. It only determines which connection the guardrails evaluate.

### API Surface

Add persona account assignment routes:

- `GET /workspaces/:id/personas/:personaId/social-accounts`
- `POST /workspaces/:id/personas/:personaId/social-accounts`
- `PATCH /workspaces/:id/personas/:personaId/social-accounts/:assignmentId`
- `DELETE /workspaces/:id/personas/:personaId/social-accounts/:assignmentId`

Add connection label route:

- `PATCH /workspaces/:id/connections/:connectionId`

The patch route edits `displayName` only at first. Identity fields are refreshed by connection test and OAuth completion.

### Web UX

Integrations:

- Provider card lists multiple account rows.
- Button says `Connect another account`.
- Each row shows provider, display name, external identity, status, test, disconnect.

Persona detail:

- Add an Accounts section.
- User assigns LinkedIn, Instagram, X, Reddit, or other social accounts to the persona.
- User marks one primary per channel/provider.
- Missing primary accounts are visible as setup gaps.

Cadence:

- When a persona is selected, the account picker filters to that persona's assigned accounts.
- If the persona has one primary account for the channel, preselect it.

Launches:

- New launch form shows whether the selected persona has required accounts for selected channels.
- Dispatch uses the resolved persona accounts by default.

Manual publish:

- Publish modal filters accounts by draft persona.
- If no assigned account exists, send the user to the persona Accounts section.

## Error Handling

New API error keys:

- `persona_account_missing`: no assigned primary account exists for persona + provider/channel.
- `persona_account_mismatch`: explicit account is not assigned to this persona.
- `persona_account_unavailable`: assigned account is disconnected, errored, or not social-capable.
- `persona_account_ambiguous`: more than one primary assignment exists because of corrupted state.
- `assignment_not_found`: assignment row does not belong to this workspace/persona.

These errors block dispatch before any connector call.

## Migration And Backward Compatibility

Existing connection rows remain valid.

Existing cadences and publications already store `connectionId`, so they continue working after the migration.

Existing personas start with no account assignments. Persona-based automated flows should block until assignments are configured. Persona-less manual publishing keeps the current explicit account picker behavior.

For current workspaces with only one connected account per provider, a one-time backfill can optionally create primary assignments for personas that already have cadences or launches using that provider. The safer default is no automatic assignment because assigning a real account to a persona is a product decision.

## Out Of Scope

- Multi-brand organization/page asset selection inside a single OAuth connection.
- A new `social_accounts` aggregate above `connections`.
- Adding new social providers.
- Changing the central brain persona overlay model.
- Reworking social engagement metrics or inbox storage.

## Testing Strategy

Test the change at five layers:

1. Contracts: connection identity fields, persona account assignment schemas, error enum coverage where applicable.
2. Connection service: multiple same-provider accounts, OAuth completion idempotency by Nango connection ID, identity refresh.
3. Persona account service: create/list/update/delete, primary enforcement, workspace isolation, provider/channel validation.
4. Routing service: primary resolution, explicit override validation, missing/unavailable/mismatch errors.
5. Pipeline tests: manual publish, cadence fill, launch dispatch, and X sequence dispatch all block or route through the expected account.

## Acceptance Criteria

1. A workspace can connect two LinkedIn accounts and two Instagram accounts without overwriting either provider.
2. A persona can be assigned one or more social accounts.
3. A persona can have exactly one primary account per provider/channel.
4. Automated launch/cadence dispatch uses the persona's primary account.
5. Manual publishing for a persona draft cannot publish through an unassigned account.
6. Disconnected assigned accounts block automation with a clear error before any platform call.
7. Publications and launch messages still store the final `connectionId` used.

## Spec Self-Review

- Completeness scan: no unresolved markers remain.
- Consistency check: `connections` owns token/health/identity; `persona_social_accounts` owns routing policy.
- Scope check: one implementation slice, focused on multi-account connection support plus persona routing.
- Ambiguity check: explicit override rules and missing-account behavior are defined.
