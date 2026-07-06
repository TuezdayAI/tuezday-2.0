# Sprint 36.3 — Social read-connectors + social corpus

**Part of:** the Onboarding V2 program — `docs/plans/onboarding-v2-roadmap.md`,
sprint **36.3 of 6**.

**Branch:** `sprint-36-3-social-read`, stacked on `sprint-36-2-website-scrape`
(**merge order: 36.1 → 36.2 → 36.3**). Do NOT merge into `main` — push the
branch; the founder reviews and merges.

**Goal:** Let onboarding Step 3 require at least one connected social account
(LinkedIn / X / Instagram) and read that account's **own profile + recent
posts** into a social corpus, exposed at `GET /workspaces/:id/social-corpus`,
that Sprint 36.4 drafts the brain from alongside 36.2's website corpus.

## Scope reality check (verified against this branch, 2026-07-07)

The roadmap assumed 36.3 was the "heavy" sprint (adding OAuth apps + provider
entries from scratch). **It is not** — main's Sprint 25/27 already shipped most
of it. What already exists on this branch:

- **Provider entries** in `CONNECTOR_PROVIDERS` (`packages/contracts/src/index.ts`):
  `linkedin`, `twitter` (this is X — the key is `twitter`), `instagram`, all
  `authMode: "oauth"`, `categories: ["social"]`.
- **OAuth creds already wired** in `OAUTH_ENV`
  (`apps/api/src/services/connections.ts:102`):
  `LINKEDIN_CLIENT_ID/_SECRET`, `TWITTER_CLIENT_ID/_SECRET`,
  `INSTAGRAM_CLIENT_ID/_SECRET` (the Instagram pair is the **Facebook app**
  id/secret — Instagram rides the Meta connection). Each provider stays
  `needs_oauth_app` until both vars are set, exactly like Reddit.
- **Adapters exist** (`apps/api/src/connectors/social/{linkedin,x,instagram}.ts`)
  implementing `SocialAdapter` with `publishPost` / `fetchEngagement` /
  `fetchReplies` / `postReply` / (X) `sendDm`.
- The generic connect flow (`connectProvider`, `registerOAuthConnection`) and the
  `ConnectorFabric` proxy (`fabric.proxyJson(method, path, connId, integrationKey,
  { form?, headers?, baseUrlOverride? })`) are the same seams the adapters use.

**So the roadmap's "add three provider entries + .env creds" is already done.**
The corrected, smaller scope of 36.3 is the *read-for-onboarding* side that no
existing adapter covers: reading the **connected user's own** bio + recent
original posts (existing `fetchReplies` reads replies to *our* published posts —
not the same thing), aggregating them into a corpus, and the min-1 gate.

## Research basis (cite file:line)

- `apps/api/src/connectors/social/index.ts:60+` — `SocialAdapter` interface; all
  read methods after `publishPost` are **optional** and feature-detected by
  callers. `readSocialProfile` will be added the same way (optional).
- `apps/api/src/connectors/social/reddit.ts` — canonical adapter using
  `fabric.proxyJson(...)` with `baseUrlOverride` + `headers`; mirror its shape.
- `apps/api/src/connectors/fabric.ts:44-95` — `ConnectorFabric` interface
  (`proxyJson` signature) and `ConnectorFabricError`.
- `apps/api/src/services/connections.ts` — `listConnections(db, workspaceId)`,
  `getConnection`, `integrationKeyFor(provider)`, `providerByKey(key)`,
  `oauthAppCredentials(providerKey)`; `OAUTH_ENV` map.
- `apps/api/src/routes/connectors.ts` — connect/list/test/disconnect route shapes
  and how the `ConnectorFabric` is injected via `BuildAppOptions.connectors`.
- `apps/api/test/*` — fake `ConnectorFabric` stub pattern (e.g. `publish.test.ts`
  `fakeFabric(state)`); tests must use it — **no live OAuth**.
- 36.1 `workspaces.onboardingStep` cursor + `advanceOnboarding`
  (`apps/api/src/services/workspaces.ts`) — where the min-1 gate hooks in.
- 36.2 `apps/api/src/services/scrape.ts` (`ScrapeResult { corpus }`) + how
  `brand-profile.ts` consumes a corpus — the social corpus mirrors this shape so
  36.4 can concatenate website + social.

## Key design decisions (stated, with rationale)

1. **Read-on-demand; no new table.** The social corpus is read live from the
   platform APIs when requested and returned in-memory — not persisted. Rationale:
   onboarding reads once, 36.4 consumes immediately, and 36.2 already set the
   precedent that raw corpus isn't stored (only the *derived* brand profile is).
   A cache table would add staleness + a migration with no second consumer. If
   36.4 later wants determinism it can snapshot the corpus into its own input.
2. **One optional `readSocialProfile(connection)` per adapter**, returning a
   normalized `SocialProfileRead`. Keeps all three platforms behind one interface
   so the corpus service is platform-agnostic; a platform that can't read (scope
   missing) throws `ConnectorFabricError`, which the corpus service turns into a
   per-provider `error` entry rather than failing the whole read.
3. **Min-1 gate is an API concern only this sprint.** A `hasSocialConnection`
   helper + enforcement when advancing the onboarding cursor past `connect`. The
   Blaze-style Step-3 reading animation + the three connect cards are **Sprint
   36.5** (UI). 36.3 ships API + contracts; no `apps/web` changes beyond none.

## Scope (in)

1. **Contracts** (`packages/contracts`): `SOCIAL_READ_PROVIDERS` (`["linkedin",
   "twitter", "instagram"]`), `socialProfileReadSchema`, `socialCorpusSchema`
   (aggregate view with per-provider entries + a concatenated `corpus` string).
2. **Read adapters**: add optional `readSocialProfile()` to `SocialAdapter` and
   implement it in `linkedin.ts`, `x.ts`, `instagram.ts` via `fabric.proxyJson`
   (profile/me + recent posts endpoints per platform), returning
   `{ handle, displayName, bio, recentPosts: { text, url, createdAt }[] }`.
3. **Social-corpus service** (`apps/api/src/services/social-corpus.ts`):
   `readSocialCorpus(db, fabric, workspaceId)` → iterate connected social
   connections, call each adapter's `readSocialProfile`, normalize + concatenate
   into a corpus string; per-provider failures become `{ provider, error }`
   entries, never throw. `hasSocialConnection(db, workspaceId)` boolean.
4. **Routes**: `GET /workspaces/:id/social-corpus` (reads live). Onboarding gate:
   `PATCH /workspaces/:id/onboarding` rejects advancing to a step past `connect`
   with `409 needs_social_connection` when `hasSocialConnection` is false.
5. **Onboarding cursor helper** wired into the existing `advanceOnboarding` path.

## Scope (out — YAGNI / later sprints)

- Any `apps/web` UI — the connect cards + reading animation are Sprint 36.5.
- Persisting/caching social posts (read-on-demand, decision #1).
- Publishing/engagement/reply changes (already shipped; untouched).
- New OAuth apps or provider entries (already exist).
- Backfill/pagination of full post history — read the most recent N (cap 25).

## Contracts (exact shapes — 36.4/36.5 depend on these names)

```ts
export const SOCIAL_READ_PROVIDERS = ["linkedin", "twitter", "instagram"] as const;
export type SocialReadProvider = (typeof SOCIAL_READ_PROVIDERS)[number];

export const socialPostReadSchema = z.object({
  text: z.string().max(5000),
  url: z.string().default(""),
  createdAt: z.number().int().nullable(),
});

export const socialProfileReadSchema = z.object({
  provider: z.enum(SOCIAL_READ_PROVIDERS),
  handle: z.string().default(""),
  displayName: z.string().default(""),
  bio: z.string().max(3000).default(""),
  recentPosts: z.array(socialPostReadSchema).max(25).default([]),
});
export type SocialProfileRead = z.infer<typeof socialProfileReadSchema>;

export const socialCorpusEntrySchema = z.object({
  provider: z.enum(SOCIAL_READ_PROVIDERS),
  profile: socialProfileReadSchema.nullable(),
  error: z.string().nullable(),
});

export const socialCorpusSchema = z.object({
  connected: z.array(z.enum(SOCIAL_READ_PROVIDERS)),
  entries: z.array(socialCorpusEntrySchema),
  /** Concatenated text for 36.4, capped. Empty when nothing readable. */
  corpus: z.string(),
});
export type SocialCorpus = z.infer<typeof socialCorpusSchema>;
```

## Adapter interface addition

```ts
// apps/api/src/connectors/social/index.ts — add to SocialAdapter (optional):
/** Read the connected account's own profile + recent original posts (36.3). */
readSocialProfile?(): Promise<SocialProfileReadRaw>;

export interface SocialProfileReadRaw {
  handle: string;
  displayName: string;
  bio: string;
  recentPosts: { text: string; url: string; createdAt: number | null }[];
}
```

Per-platform endpoints (confirm exact fields at implement-time against the live
app's granted scopes; founder confirms read scopes are granted):
- **LinkedIn**: `GET /v2/userinfo` (OpenID profile) for name/handle; member posts
  via the `/rest/posts?author={urn}` (or `ugcPosts`) read — gated by
  `r_member_social`. Reuse `linkedin.ts`'s existing `authorUrn()` helper.
- **X (twitter)**: `GET /2/users/me?user.fields=description,username,name` for
  bio/handle; `GET /2/users/:id/tweets?max_results=25` for recent posts
  (`users.read` + `tweet.read`). Reuse `x.ts`'s `resolveUserId`.
- **Instagram**: `GET /{ig-user-id}?fields=biography,username` + `GET
  /{ig-user-id}/media?fields=caption,permalink,timestamp&limit=25` on the Graph
  API (`instagram_basic` + linked FB Page). Reuse `instagram.ts`'s `igUserId()`.

## Routes + gate

- `GET /workspaces/:id/social-corpus` → `SocialCorpus` (reads live; membership
  already enforced by the guard).
- `PATCH /workspaces/:id/onboarding` (36.1 route): when the requested `step` is
  after `connect` in `ONBOARDING_STEPS` and `hasSocialConnection(db, id)` is
  false → `409 { error: "needs_social_connection" }`. Advancing *to* `connect`
  or earlier, or to `done`, is unaffected.

## Tests (before implementation — stubbed fabric, no live OAuth)

- contracts: `SOCIAL_READ_PROVIDERS` fixed; `socialCorpusSchema` accepts an entry
  with `profile:null,error:"…"`; rejects an unknown provider.
- api unit (`social-corpus.test.ts`): with a **fake `ConnectorFabric`** returning
  canned profile/posts JSON per platform and a seeded `connections` row —
  `readSocialCorpus` returns one entry per connected social, concatenates text,
  and a failing platform yields `{ provider, error }` without sinking the others;
  `hasSocialConnection` true iff ≥1 social connection row exists.
- api routes: `GET …/social-corpus` returns the aggregate; onboarding PATCH to
  `verify` with no social connection → 409; with one connected → 200; PATCH to
  `connect` with none → still 200 (gate only guards *past* connect).
- Each adapter's `readSocialProfile` unit-tested against a fake fabric returning
  that platform's JSON shape → normalized `SocialProfileReadRaw`.

## Founder acceptance

With the three OAuth cred pairs in `.env` and a real connected account: connect
one of LinkedIn/X/Instagram in the workspace → `GET /workspaces/:id/social-corpus`
returns your handle, bio, and recent posts; onboarding refuses to advance past
`connect` until at least one is connected. (Stubbed tests prove the wiring
without live OAuth.)

## Bite-sized tasks

- **Task 1 — Contracts** (`packages/contracts/src/index.ts` + test): add
  `SOCIAL_READ_PROVIDERS`, the four schemas above. TDD: failing contracts test →
  implement → green → commit.
- **Task 2 — Adapter read methods**: add `readSocialProfile?` + `SocialProfileReadRaw`
  to `social/index.ts`; implement in `linkedin.ts`, `x.ts`, `instagram.ts` via
  `fabric.proxyJson`. TDD per adapter with a fake fabric returning canned JSON.
- **Task 3 — Social-corpus service** (`services/social-corpus.ts`):
  `readSocialCorpus` + `hasSocialConnection`, per-provider error isolation, 25-post
  cap, corpus concatenation + length cap (reuse 36.2's 20 000-char ceiling). TDD.
- **Task 4 — Routes + gate**: `GET /workspaces/:id/social-corpus`; extend the
  36.1 onboarding PATCH with the min-1 gate. Register the route in `app.ts`
  (pass the injected `connectors` fabric). TDD via injected fake fabric.
- **Task 5 — Full green + push**: `npm test`, `npm run typecheck`,
  `npm run build -w apps/web`; update Progress log; push branch. Do NOT merge.

Each task: write failing test → run (fail) → implement → run (pass) → commit with
the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Progress log

- 2026-07-07 — Spec drafted on branch `sprint-36-3-social-read` (stacked on 36.2
  tip `31a860b`). Scope corrected after reading the branch: provider entries +
  `OAUTH_ENV` creds + publish/engagement adapters already exist (main Sprints
  25/27); the real 36.3 work is the *read-for-onboarding* side (`readSocialProfile`
  + social corpus + min-1 gate). Awaiting founder review; not implemented.
