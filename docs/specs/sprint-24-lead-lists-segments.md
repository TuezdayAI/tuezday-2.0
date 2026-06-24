# Sprint 24 — Lead lists & segments

> Phase B, item C3 (part 1) in `docs/plans/sprint-guide-21-onward.md`.
> Branch: `sprint-24-lead-lists-segments`, off `main`. **No dependency on an
> unmerged 21+ sprint** — it builds only on already-merged slices (`leads`
> Sprint 11, `crm_contacts` Sprint 13, `campaigns` Sprint 7/8), so it merges
> into `main` independently of Sprints 21/22/23.
> This spec stands alone: the founder resets the session between sprints.

## Goal

Group leads and contacts into reusable, targetable **audiences** — the missing
primitive for targeted campaigns. An audience is either a **static list**
(hand-picked members) or a **dynamic segment** (a saved AND/OR rule tree
evaluated live over lead/contact fields). An audience can be attached to one or
more campaigns as its structured audience. Sprint 25 will launch outbound /
social-DM at an audience; Sprint 24 only defines and attaches them — **no
sending here.**

## Founder decisions (2026-06-19, captured before implementation)

1. **Member scope: unified leads + contacts.** Membership is polymorphic over
   both `leads` and synced `crm_contacts`, not leads-only.
2. **Rule engine: AND/OR nested groups.** Segments use a recursive rule tree
   with mixed `and`/`or` combinators, not a single AND-only group.
3. **Campaign link: many per campaign.** A campaign references zero or more
   audiences via a join table; the existing free-text `campaigns.audience`
   field stays as the human description.

## The "people pool" (how leads + contacts unify)

Leads and CRM contacts share the same shape (`name`, `email`, `company`,
`role`). A CRM contact that has been imported as a lead carries a `leadId` link.
To avoid listing the same person twice, the **people pool** for a workspace is:

> **all `leads` + all `crm_contacts` whose `leadId IS NULL`.**

Each pool entry is a **Person**: `{ type: "lead" | "contact", id, name, email,
company, role }`. The pool is the single source used for (a) the static-list
member picker, (b) dynamic-segment evaluation, and (c) resolving an audience's
members. This keeps a linked contact represented once — as its lead.

`notes` exists on leads but not contacts, so it is **not** a segment rule field
(rules must apply uniformly to both member types). Rule fields are the common
set plus a derived email domain and the member type (see below).

## Data model (new tables → migration `0018`)

Edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api` to emit
`apps/api/drizzle/0018_*.sql`. Keep it Postgres-portable (text ids, integer
epoch-ms, no SQLite-only tricks), matching the existing house style.

### `audiences`
| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `name` | text NOT NULL | |
| `description` | text NOT NULL default "" | |
| `kind` | text NOT NULL | `static` \| `dynamic` |
| `rulesJson` | text | the rule tree for dynamic; `null` for static |
| `createdAt` / `updatedAt` | integer NOT NULL | |

### `audience_members` (static membership; polymorphic)
| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces (cascade) | scoping/cleanup |
| `audienceId` | text NOT NULL → audiences (cascade) | |
| `memberType` | text NOT NULL | `lead` \| `contact` |
| `memberId` | text NOT NULL | leads.id or crm_contacts.id (no FK — polymorphic) |
| `addedAt` | integer NOT NULL | |
| unique index | (`audienceId`, `memberType`, `memberId`) | idempotent add |

Polymorphic `memberId` can't carry a FK, so referential integrity is enforced in
the service: members are validated on add, **and dangling rows are filtered out
on read** (a lead/contact deleted elsewhere never appears). `deleteLead` also
cleans up its membership rows for tidiness.

### `campaign_audiences` (join: campaign ↔ audience)
| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces (cascade) | |
| `campaignId` | text NOT NULL → campaigns (cascade) | |
| `audienceId` | text NOT NULL → audiences (cascade) | |
| `createdAt` | integer NOT NULL | |
| unique index | (`campaignId`, `audienceId`) | |

## Contracts (`packages/contracts/src/index.ts`)

All enum vocabularies and the rule evaluator live here (contracts is the only
place enums are defined; pure validators already live here — `validateAdCreative`
etc. — so the segment evaluator follows that precedent and is unit-tested
through the api suite).

- `AUDIENCE_KINDS = ["static", "dynamic"]`, `AudienceKind`.
- `AUDIENCE_MEMBER_TYPES = ["lead", "contact"]`, `AudienceMemberType`.
- `SEGMENT_FIELDS = ["name", "email", "email_domain", "company", "role", "type"]`,
  `SegmentField`.
- `SEGMENT_OPERATORS = ["equals", "not_equals", "contains", "not_contains",
  "starts_with", "is_set", "is_empty"]`, `SegmentOperator`.
- `segmentConditionSchema` — `{ field, operator, value? }`. `value` required for
  all operators except `is_set` / `is_empty`. For `field: "type"`, value must be
  a member type.
- `segmentRuleGroupSchema` — recursive (`z.lazy`): `{ combinator: "and"|"or",
  rules: Array<group | condition> }`. Bounded: max depth 5, max 50 conditions
  total (a `superRefine` counts nodes) to keep "simple rule-based" honest.
- `personSchema` — `{ type, id, name, email, company, role }`.
- `evaluateSegment(person: Person, group: SegmentRuleGroup): boolean` — pure,
  case-insensitive string compares; `email_domain` = substring after `@`;
  `type` compares the member type; empty group (`rules: []`) matches everyone
  (an empty AND is vacuously true — a brand-new segment shows all people until
  rules are added). Exported for the service + tests.
- `audienceSchema`, `audienceMemberSchema` (the resolved Person + `addedAt?`),
  `createAudienceInputSchema` / `updateAudienceInputSchema`
  (`name` required; `description`; `kind`; `rules` required-and-non-trivial only
  when `kind==="dynamic"`, forbidden when static — `superRefine`).
- `addAudienceMembersInputSchema` — `{ members: {type,id}[] }`, 1..500.
- `attachAudienceInputSchema` — `{ audienceId }`.

## Services (`apps/api/src/services/audiences.ts`)

Pure data + business logic; no provider code. Functions:

- `loadPeople(db, workspaceId): Person[]` — the people pool (leads + unlinked
  contacts), the shared source described above.
- `rowToAudience(row)` — parse `rulesJson`.
- `createAudience` / `listAudiences` (each with `memberCount`) / `getAudience` /
  `updateAudience` / `deleteAudience`.
- `resolveAudienceMembers(db, workspaceId, audience): Person[]` —
  - static: load `audience_members`, map to current pool people, drop dangling.
  - dynamic: `loadPeople(...).filter(p => evaluateSegment(p, rules))`.
- `addAudienceMembers(db, ws, audienceId, members)` — static only (409 on
  dynamic); validate each `{type,id}` exists in the pool; idempotent insert.
- `removeAudienceMember(db, ws, audienceId, type, id)`.
- `listCampaignAudiences(db, ws, campaignId)` / `attachAudience` (idempotent;
  validates both exist; 409 if audience archived/missing) / `detachAudience`.
- Extend `services/campaigns.ts` `getCampaignDetail` to include
  `audiences: { id, name, kind, memberCount }[]`.
- Extend `services/leads.ts` `deleteLead` to delete the lead's
  `audience_members` rows.

## API routes (`apps/api/src/routes/audiences.ts` → `registerAudienceRoutes(app, db)`)

Thin (validate with a contracts schema, call the service), `workspaceOr404`
guard like every sibling route. Register in `apps/api/src/app.ts`. All under the
authed workspace guard already in place.

- `GET    /workspaces/:id/people` — the people pool (picker + preview).
- `POST   /workspaces/:id/audiences` (201) — create.
- `GET    /workspaces/:id/audiences` — list with member counts.
- `GET    /workspaces/:id/audiences/:audienceId` — `{ audience, members }`.
- `PUT    /workspaces/:id/audiences/:audienceId` — update name/desc/rules.
- `DELETE /workspaces/:id/audiences/:audienceId` (204).
- `POST   /workspaces/:id/audiences/:audienceId/members` — add static members.
- `DELETE /workspaces/:id/audiences/:audienceId/members/:memberType/:memberId`.
- `POST   /workspaces/:id/campaigns/:campaignId/audiences` — attach `{audienceId}`.
- `DELETE /workspaces/:id/campaigns/:campaignId/audiences/:audienceId` — detach.
- `GET    /workspaces/:id/campaigns/:campaignId/audiences` — list attached.

Error vocabulary: `workspace_not_found`, `audience_not_found`,
`campaign_not_found`, `member_not_found`, `not_a_static_list` (409 adding members
to a dynamic segment), `invalid_input` (400).

## Web (`apps/web`)

- Nav: add child **"Lists & segments"** (path `/lists`) under the existing
  **Audience** group in `app/workspaces/[id]/layout.tsx`.
- New page `app/workspaces/[id]/lists/page.tsx`:
  - List audiences with a kind badge (`static`/`dynamic`) and member count.
  - Create/edit form: name, description, kind toggle. Dynamic → a **recursive
    AND/OR rule builder** (add condition / add nested group / pick combinator /
    remove); static → member picker from `GET /people` + current members with
    remove.
  - Expand an audience → resolved members (name · role · company · type badge).
  - "Attach to campaign": pick an active campaign → attach; show attached chips.
- Campaigns page (`campaigns/page.tsx`): in the expanded detail, show an
  **Audiences** line listing attached audiences (name · kind · n members) using
  the extended campaign-detail payload.

## Boundary

- **No sending / sequence launch** — that is Sprint 25. Audiences are defined and
  attached only.
- No CRM discard/tombstone dependency (that's Sprint 23, a separate branch) —
  Sprint 24 works off whatever `leads` + `crm_contacts` exist.
- No new event types / webhooks for this slice.

## Tests (`apps/api/test/audiences.test.ts`, plus a `campaigns` detail assertion)

Follow the one-file-per-slice convention; `buildAuthedApp` + `createTestDb`,
assert against the contracts zod schemas.

1. **Segment evaluator (unit, via contracts):** AND, OR, nested AND/OR,
   `contains`/`equals`/`is_set`/`is_empty`/`email_domain`/`type`, empty group
   matches all. Depth/size cap rejected by the schema.
2. **CRUD:** create static + dynamic; reject empty name; reject rules on static /
   missing rules on dynamic; list carries member counts; 404 unknown; delete.
3. **People pool:** leads + unlinked contacts only; a contact linked to a lead
   appears once (as the lead).
4. **Static membership:** add lead + contact, idempotent re-add, remove; adding
   to a dynamic segment → 409 `not_a_static_list`; adding a nonexistent person →
   `member_not_found`; deleting a lead drops it from lists.
5. **Dynamic resolution:** seed leads/contacts; "VPs at fintech"
   (`role contains VP` AND (`company contains fintech` OR
   `email_domain contains fintech`)) returns exactly the expected people; edits
   to rules change membership live.
6. **Campaign attach:** attach two audiences → campaign detail lists both with
   counts; detach; attaching an unknown audience → 404; idempotent re-attach.

`npm test` and `npm run typecheck` must pass green.

## Founder acceptance (added to `docs/founder-acceptance-tests.md`)

Create a static list, hand-pick a few leads/contacts; create the segment "VPs at
fintech" with an AND/OR rule and watch members resolve live; attach both to a
campaign and see them on the campaign; edit a rule and watch membership change.

## Step plan

1. Spec (this file). ✅
2. Contracts: enums, schemas, recursive rule schema, `evaluateSegment`, Person.
3. Schema: three tables; `db:generate` → `0018`.
4. Service `audiences.ts`; extend `campaigns.getCampaignDetail` + `leads.deleteLead`.
5. Routes `audiences.ts`; wire into `app.ts`.
6. Tests; `npm test` + `npm run typecheck` green.
7. Web: nav, `/lists` page (rule builder + member picker + attach), campaign detail line.
8. Update `docs/founder-acceptance-tests.md` with the Sprint 24 section.
9. Commit to the sprint branch and push; founder reviews/merges.

## Progress log

- 2026-06-19 — Spec written. Founder decisions captured (unified members, AND/OR
  rules, many-per-campaign).
- 2026-06-19 — Implemented end to end:
  - Contracts: audience/segment enums, recursive AND/OR rule schema (depth ≤ 5,
    ≤ 50 conditions), `Person`, and the pure `evaluateSegment` evaluator.
  - DB: `audiences`, `audience_members` (polymorphic), `campaign_audiences`;
    migration `0018_demonic_tempest.sql`.
  - Service `audiences.ts` (people pool = leads + unlinked contacts; CRUD; live
    member resolution; static membership; campaign attach/detach). Extended
    `campaigns.getCampaignDetail` (attached audiences) and `leads.deleteLead`
    (membership cleanup).
  - Routes `audiences.ts` wired into `app.ts` (`/people`, `/audiences*`,
    `/campaigns/:id/audiences*`).
  - Web: nav child **Lists & segments**, `/lists` page (recursive rule builder,
    static member picker, campaign attach), campaign-detail Audiences line.
  - Tests: `apps/api/test/audiences.test.ts` (19 cases incl. the evaluator).
    Full suite **537 passing**; `npm run typecheck` green across all workspaces.
  - Founder acceptance section added to `docs/founder-acceptance-tests.md`.
  - Ready for founder review/merge. **Not merged into `main`.**
