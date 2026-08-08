# Development Admin Bootstrap Design

## Goal

Provide a local/staging-only bootstrap account that starts with one complete,
owned demo workspace and enters it through the ordinary email/password login
form. The feature must be inert in production and must never include
credentials in version-controlled files.

## Scope

- Add blank `DEV_ADMIN_EMAIL` and `DEV_ADMIN_PASSWORD` entries to
  `.env.example`; values live only in ignored local environment files or the
  staging secret store.
- On API process start, when `NODE_ENV !== "production"` and both variables
  are non-empty, run a synchronous, idempotent bootstrap service after the
  database is opened.
- Normalize the configured email and ensure a normal `users` row exists. A
  missing account is created with the configured password; an existing account
  is given the configured password so its declared local/staging credentials
  always work. It has no global privilege.
- Ensure one workspace with the deterministic demo identity is owned by that
  account. Ownership uses the existing `workspace_members.role = "owner"`
  relationship; no administrator role, auth bypass, public endpoint, special
  UI, or seed command is introduced.
- Mark the workspace onboarding cursor as `done`, then seed a cohesive
  fictional-company dataset once.
- Return the bootstrap owner’s workspace ID from the existing login response
  and have the existing form navigate directly to `/workspaces/{id}`. Login
  remains otherwise unchanged, including an explicit `next` destination.

## Data and Idempotency

The bootstrap workspace is located by a stable owner + workspace identity and
is always repaired to have the configured user as owner. A small internal
`dev_bootstrap_seeds` ledger records the dataset version for that workspace.
It has a uniqueness constraint on workspace ID and is written only after all
seed records are created. Consequently restarts do not duplicate records, and
an existing demo workspace with no ledger is seeded exactly once.

The seeded company is deterministic and uses existing services/data shapes:

- all five Brain documents with useful, editable GTM context;
- two personas and one active campaign that references both;
- an audience, leads, media contacts, and a PR pitch context;
- discovery sources/items and matching signals;
- recorded generations and approval drafts in pending-review, approved, and
  edited states, with the existing approval-decision history;
- safe local campaign artifacts such as an outbound launch/sequence, social
  automation settings, and workspace insights inputs where their records do
  not require a provider connection.

The seed does not fabricate OAuth connections, billing subscriptions, API
keys, live publication records, remote storage assets, or any record that
would trigger an external network call. The bootstrap service calls existing
domain services when they express the needed invariant; narrowly scoped direct
inserts are reserved for historical demo data whose normal creation path would
invoke an LLM or a provider.

## Architecture

`apps/api/src/services/dev-bootstrap.ts` owns all environment gating,
normalization, account/workspace repair, ledger checks, and deterministic
content creation. It depends only on the database and established local
services. A single `bootstrapDevAdmin(db, env)` call from `server.ts` runs after
`createDb` and before Fastify starts listening.

The app composition root remains unchanged: tests do not bootstrap from ambient
process variables. Service-level tests explicitly pass an environment object
and use the in-memory migrated database. Production disabling is checked by
the bootstrap service itself as well as by startup call conditions, preventing
accidental activation when the service is reused.

The normal login service determines whether the authenticated user owns the
configured bootstrap workspace by using the same configured email and the
existing ownership table. Its response gains an optional `redirectWorkspaceId`.
The web form honours `next` first; without `next`, it uses that ID, then keeps
the current `/` fallback for every other user.

## Error Handling and Security

- In production, incomplete configuration, and absent credentials: return
  without writes and without logging sensitive values.
- Startup logs only that development bootstrap is enabled/complete or skipped;
  it never logs the email, password, token, or seeded content.
- A malformed configured email is reported as a configuration error before any
  writes, without leaking the password.
- The password is stored only using the project’s existing scrypt helper.
- The `redirectWorkspaceId` is returned only after successful authentication
  and only for the configured local/staging bootstrap user who owns that
  workspace.

## Tests

Service/API tests prove:

1. production and incomplete configuration make no writes;
2. enabled configuration creates a normal account, one owned workspace, a
   `done` onboarding cursor, seed ledger, and representative records;
3. a second run preserves IDs and counts, repairs missing ownership, and does
   not duplicate the seeded data;
4. normal login with the configured credentials returns the workspace redirect
   ID, while another user’s login does not;
5. the existing login page chooses an explicit `next` value first, otherwise
   the returned workspace redirect, otherwise `/`.

## Non-Goals

- A global administrator role or any authorization change.
- A production demo account.
- A special login button, setup wizard, API seed route, CLI command, or manual
  data operation.
- Seeding credentials, provider integrations, or remote side effects.
