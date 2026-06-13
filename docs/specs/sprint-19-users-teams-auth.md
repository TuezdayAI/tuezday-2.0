# Sprint 19 — Users, Teams & Auth

> Date: 2026-06-12. Minimum viable identity so more than one human can work in a workspace.
> Per the founder scope note (2026-06-11): team invites need *some* user identity — the invite
> has to land on an account, and the approval-gate decision log needs a real "who". This sprint
> builds exactly that minimum. It is not an enterprise auth project.

## Goal

A user registers with email + password, logs in, and sees only the workspaces they belong to.
A workspace owner invites a teammate by email; the teammate accepts and joins as a member.
Every approval-gate decision and every brain-doc version records the real acting user.
A non-member cannot touch a workspace through any route.

## Decisions

- **Email + password**, not magic link. There is no mailer in the stack yet; a magic link
  without email sending is a contradiction. Passwords hashed with Node's built-in `scrypt`
  (no new dependency), random per-user salt, constant-time comparison.
- **Opaque bearer session tokens.** Login returns a random 256-bit token; the API stores only
  its SHA-256 hash in a `sessions` table with a 30-day expiry. Clients send
  `Authorization: Bearer <token>`. The web app keeps the token in `localStorage` — acceptable
  for this stage; revisit (httpOnly cookie + CSRF) if/when Tuezday is hosted multi-tenant.
- **Invite links, not invite emails.** Creating an invite returns a tokenized accept link the
  owner copies and sends however they like (again: no mailer). The invite is bound to the
  invitee's email — only a logged-in user with that email can accept it. Invites expire in 7 days.
- **Worker service token.** The worker calls the HTTP API across all workspaces. A shared
  secret (`TUEZDAY_WORKER_TOKEN` on both processes) authenticates it as the `system` actor with
  access to every workspace. If unset, worker requests are rejected like any other anonymous call.
- **Legacy workspace claim.** Workspaces created before this sprint have no members. The first
  authenticated user to touch such a workspace is attached as its **owner** automatically.
  This migrates the founder's existing dev data without a manual backfill; once claimed, the
  workspace is closed to non-members like any other.

## Data

New tables (migration `0016_users-teams-auth`):

- `users` — id, email (unique, stored lowercase), name, password_hash (`scrypt$salt$hash`),
  created_at, updated_at.
- `sessions` — id, user_id (fk cascade), token_hash (unique), created_at, expires_at.
- `workspace_members` — id, workspace_id (fk cascade), user_id (fk cascade), role
  (`owner` | `member`), created_at; unique (workspace_id, user_id).
- `workspace_invites` — id, workspace_id (fk cascade), email (lowercase), role (always
  `member` for now), token (unique), status (`pending` | `accepted` | `revoked`),
  invited_by (user id), created_at, expires_at, accepted_at.

Altered tables:

- `approval_decisions` + `actor_id` (nullable; old rows keep `actor = "founder"`, `actor_id = null`).
  `actor` now stores the acting user's display name (name or email), or `"system"` for the worker.
- `brain_document_versions` + `actor` and `actor_id` (both nullable for pre-auth rows).

Contracts (`packages/contracts`): `WORKSPACE_ROLES = ["owner", "member"]`,
`INVITE_STATUSES = ["pending", "accepted", "revoked"]`, `userSchema`, `workspaceMemberSchema`,
`workspaceInviteSchema`, `registerInputSchema` (email, password ≥ 8 chars, optional name),
`loginInputSchema`, `createInviteInputSchema`.

## API

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /auth/register` | public | Create account; 409 `email_taken` on duplicate; returns `{ token, user }` (201) |
| `POST /auth/login` | public | 401 `invalid_credentials` on any failure; returns `{ token, user }` |
| `POST /auth/logout` | session | Revokes the presented session (204) |
| `GET /auth/me` | session | `{ user, memberships: [{ workspaceId, workspaceName, role }] }` |
| `GET /workspaces` | session | Only workspaces the user is a member of |
| `POST /workspaces` | session | Creates workspace; creator becomes `owner` |
| `GET /workspaces/:id/members` | member | List members (id, email, name, role, joined) |
| `DELETE /workspaces/:id/members/:userId` | owner | Remove a member; 409 `last_owner` if it would leave zero owners |
| `POST /workspaces/:id/invites` | owner | `{ email }` → 201 invite incl. `token`; 409 `already_member` / `already_invited` |
| `GET /workspaces/:id/invites` | owner | Pending invites |
| `DELETE /workspaces/:id/invites/:inviteId` | owner | Revoke a pending invite |
| `GET /invites/:token` | session | Preview: workspace name, invited email, status |
| `POST /invites/:token/accept` | session | Email must match (case-insensitive) → 403; expired/revoked/used → 410; creates `member` membership |

Enforcement (global, in `buildApp`):

- Public paths: `/health`, `POST /auth/register`, `POST /auth/login`, CORS preflight.
  Everything else requires a valid session (else 401 `unauthenticated`).
- Every `/workspaces/:id/...` route additionally requires membership in that workspace
  (else 403 `not_a_member`) — enforced once in a central preHandler hook, not per-route.
  Owner-only routes (members/invites management) check the role on top.
- The worker token authenticates as actor `system` (no user id) with access to all workspaces.

Attribution: `services/drafts.ts` drops the hardcoded `ACTOR = "founder"`; every decision log
write takes the acting user from the request (display name + user id). `services/brain.ts`
stamps the same onto each new brain-doc version. The `system` actor covers worker-driven writes.

## Web

- `lib/api.ts` — single fetch helper: attaches the bearer token, redirects to `/login` on 401.
  All pages switch from raw `fetch` to it.
- `/login` — login + register in one page; on success stores token and goes to `/`.
- `/` — requires auth; lists *my* workspaces; shows signed-in user + logout.
- Workspace layout — signed-in user chip with logout; new **Team** nav item.
- `/workspaces/[id]/team` — members list with roles; owner sees invite form (email →
  copyable accept link), pending invites with revoke, and remove-member actions.
- `/invites/[token]` — shows the invite; if not logged in, routes through `/login` and back;
  accept → redirect into the workspace.

## Out of scope

SSO/SAML, OAuth login providers, magic links (no mailer), password reset (no mailer — founder
can reset via DB for now), role matrices or per-module permissions, billing/plans/seats,
transferring ownership UI, audit log UI beyond the existing decision log.

## Automated verification

- `apps/api/test/auth.test.ts` — register/login/logout/me, duplicate email, short password,
  wrong password, invalid/expired token, 401 on protected routes.
- `apps/api/test/teams.test.ts` — workspace scoping (member vs non-member 403), creator is
  owner, invite lifecycle (owner-only, accept with matching email, mismatch 403, expired and
  revoked 410, duplicate 409), remove member + last-owner guard, legacy claim, worker token,
  decision-log and brain-version actor attribution.
- All existing suites run through an authenticated test harness (real register + bearer token,
  no auth bypass flag).

## Acceptance (founder)

- [ ] Register an account, log out, log back in.
- [ ] Old workspaces appear and open normally (legacy claim makes you owner silently).
- [ ] Invite a teammate's email from the Team page; copy the link.
- [ ] Teammate (other browser/incognito) registers with that email, opens the link, accepts, sees the workspace.
- [ ] Teammate approves a pending draft → decision log on the draft shows the teammate's name, not "founder".
- [ ] Edit a brain doc as each user → version history shows who wrote each version.
- [ ] A third account that was never invited gets blocked from the workspace (and it never shows in their list).
- [ ] Worker keeps polling fine with `TUEZDAY_WORKER_TOKEN` set in both `.env`s.
