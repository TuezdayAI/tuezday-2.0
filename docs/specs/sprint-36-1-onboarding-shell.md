# Sprint 36.1 — Onboarding wizard shell + identity + workspace bootstrap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Part of:** the Onboarding V2 program — see `docs/plans/onboarding-v2-roadmap.md`.
This is sprint **36.1 of 6**. It builds only on already-merged sprints, so it
branches off `main`.

**Branch:** `sprint-36-1-onboarding-shell` (off `main`). Do NOT merge into `main`
— push the branch; the founder reviews and merges.

**Goal:** Replace the bare "create workspace" form with a guided, greeted
multi-step onboarding wizard. In this sprint only the first two steps are
functional — capture the user's **name** and the **website URL**, create the
workspace carrying that URL and an onboarding cursor, and land the user in the
app. Steps 3–7 render as honest "coming up" placeholders so the whole rail is
visible. This is the frame sprints 36.2–36.6 fill in.

**Architecture:** Additive only. Two nullable columns on `workspaces`
(`website_url`, `onboarding_step`); two small contract additions
(`ONBOARDING_STEPS`/cursors + input schemas); one new `PATCH /auth/me`; one new
`PATCH /workspaces/:id/onboarding`; a new Next.js client route `app/onboarding/`.
Nothing existing is removed — the inline quick-create form stays as a dev/escape
hatch, so every current test and flow keeps working.

**Tech Stack:** TypeScript. Fastify (routes → services → db), Drizzle on
better-sqlite3, zod contracts in `packages/contracts`, Vitest (contracts + api;
`apps/web` has no test runner — web is manually verified). Next.js App Router.

## Global Constraints (copied from CLAUDE.md / repo reality)

- **DB access only inside `apps/api/src/db` and services.** Keep the schema
  Postgres-portable (nullable `text`/`integer` columns only).
- **Enum vocabularies live only in `packages/contracts`.** `ONBOARDING_STEPS`
  is defined there and imported everywhere (web rail, api validation).
- **Auth is real in tests** — use `buildAuthedApp` / `registerUser` from
  `apps/api/test/helpers.ts`; never bypass the guard.
- **`apps/web` has NO test runner** — any logic worth testing lives in
  `packages/contracts`; the wizard UI is verified manually.
- **No Tailwind in `apps/web`** — style on the oklch token system in
  `apps/web/app/globals.css` (existing classes: `.site-header`, `.site-main`,
  `.create-form`, `.subtitle`, `.error`, `.workspace-card`, `.panel`,
  `.page-header`, `.module-in`; motion is guarded by
  `@media (prefers-reduced-motion: no-preference)`).
- **`PATCH` is already allowed by CORS** (`apps/api/src/app.ts:67`) — no config
  change needed.
- **Migrations:** after editing `apps/api/src/db/schema.ts`, run
  `npm run db:generate -w apps/api` (produces the next `apps/api/drizzle/00NN_*.sql`).
  Do NOT hand-write SQL. In-memory test DB applies all checked-in migrations.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/contracts/src/index.ts` | Modify | Add `ONBOARDING_STEPS`, `ONBOARDING_CURSORS`, types; extend `workspaceSchema` + `createWorkspaceInputSchema`; add `updateUserInputSchema`. |
| `packages/contracts/test/onboarding.test.ts` | Create | TDD for the above. |
| `apps/api/src/db/schema.ts` | Modify | Add `websiteUrl`, `onboardingStep` nullable columns to `workspaces`. |
| `apps/api/drizzle/00NN_*.sql` | Create (generated) | Migration for the two columns. |
| `apps/api/src/services/workspaces.ts` | Modify | Store + return the two columns; `advanceOnboarding()`. |
| `apps/api/src/services/auth.ts` | Modify | `updateUserName()`. |
| `apps/api/src/routes/workspaces.ts` | Modify | `PATCH /workspaces/:id/onboarding`. |
| `apps/api/src/routes/auth.ts` | Modify | `PATCH /auth/me`. |
| `apps/api/test/workspaces.test.ts` | Modify | Tests for URL persistence + onboarding cursor. |
| `apps/api/test/auth.test.ts` | Modify | Tests for `PATCH /auth/me`. |
| `apps/web/app/onboarding/page.tsx` | Create | The wizard (name + website functional; rest placeholder). |
| `apps/web/app/onboarding/onboarding.css` (or globals append) | Create/Modify | Wizard + progress-rail styles on native tokens. |
| `apps/web/app/page.tsx` | Modify | Primary "Start onboarding" entry → `/onboarding`; keep inline quick-create. |

---

## Task 1: Contracts — onboarding steps + schema extensions

**Files:**
- Modify: `packages/contracts/src/index.ts` (workspace block ~lines 49–65)
- Test: `packages/contracts/test/onboarding.test.ts`

**Interfaces produced (36.2–36.6 depend on these names):**
- `ONBOARDING_STEPS: readonly ["name","website","connect","verify","brain","campaign","draft"]`
- `OnboardingStep` = element of the above
- `ONBOARDING_CURSORS` = `[...ONBOARDING_STEPS, "done"]`; `OnboardingCursor` = element
- `workspaceSchema.websiteUrl: string | null`, `workspaceSchema.onboardingStep: OnboardingCursor | null`
- `createWorkspaceInputSchema.websiteUrl?: string (url)`, `.onboardingStep?: OnboardingCursor`
- `updateUserInputSchema` = `{ name: string (1–100, trimmed) }`; `UpdateUserInput`

- [ ] **Step 1: Write the failing test** — `packages/contracts/test/onboarding.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  ONBOARDING_CURSORS,
  workspaceSchema,
  createWorkspaceInputSchema,
  updateUserInputSchema,
} from "../src/index";

describe("onboarding contracts", () => {
  it("lists the seven visible steps in order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "name", "website", "connect", "verify", "brain", "campaign", "draft",
    ]);
  });

  it("cursors add a terminal 'done'", () => {
    expect(ONBOARDING_CURSORS).toEqual([...ONBOARDING_STEPS, "done"]);
  });

  it("workspaceSchema accepts null website + cursor", () => {
    const base = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "X", createdAt: 1, updatedAt: 1 };
    expect(workspaceSchema.safeParse({ ...base, websiteUrl: null, onboardingStep: null }).success).toBe(true);
    expect(workspaceSchema.safeParse({ ...base, websiteUrl: "https://a.co", onboardingStep: "connect" }).success).toBe(true);
  });

  it("createWorkspaceInputSchema takes an optional valid URL, rejects a bad one", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "X" }).success).toBe(true);
    expect(createWorkspaceInputSchema.safeParse({ name: "X", websiteUrl: "https://a.co" }).success).toBe(true);
    expect(createWorkspaceInputSchema.safeParse({ name: "X", websiteUrl: "not-a-url" }).success).toBe(false);
  });

  it("updateUserInputSchema trims and bounds the name", () => {
    expect(updateUserInputSchema.safeParse({ name: "  Ada  " }).data?.name).toBe("Ada");
    expect(updateUserInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(updateUserInputSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @tuezday/contracts -- onboarding`
Expected: FAIL — `ONBOARDING_STEPS` is not exported.

- [ ] **Step 3: Implement in `packages/contracts/src/index.ts`**

Immediately BEFORE `export const workspaceSchema = z.object({` (~line 49), add:

```ts
export const ONBOARDING_STEPS = [
  "name",
  "website",
  "connect",
  "verify",
  "brain",
  "campaign",
  "draft",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_CURSORS = [...ONBOARDING_STEPS, "done"] as const;
export type OnboardingCursor = (typeof ONBOARDING_CURSORS)[number];
```

Replace the `workspaceSchema` object body to add two fields:

```ts
export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  websiteUrl: z.string().url().nullable(),
  onboardingStep: z.enum(ONBOARDING_CURSORS).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
```

Replace `createWorkspaceInputSchema` to add two optional inputs:

```ts
export const createWorkspaceInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be 100 characters or fewer"),
  websiteUrl: z.string().url("Enter a valid URL, e.g. https://acme.com").optional(),
  onboardingStep: z.enum(ONBOARDING_CURSORS).optional(),
});
```

Add, right after the `CreateWorkspaceInput` type (~line 64), the user-update schema:

```ts
export const updateUserInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name must be 100 characters or fewer"),
});
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -w @tuezday/contracts -- onboarding`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/onboarding.test.ts
git commit -m "Sprint 36.1: onboarding step vocabulary + workspace/user schema fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: DB schema + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:6-11` (the `workspaces` table)
- Create (generated): `apps/api/drizzle/00NN_*.sql`

**Interfaces produced:** `WorkspaceRow.websiteUrl: string | null`,
`WorkspaceRow.onboardingStep: string | null`.

- [ ] **Step 1: Add the columns** — in `apps/api/src/db/schema.ts`, the
  `workspaces` table becomes:

```ts
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  websiteUrl: text("website_url"),
  onboardingStep: text("onboarding_step"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate -w apps/api`
Expected: a new `apps/api/drizzle/00NN_*.sql` adding two nullable columns
(`ALTER TABLE workspaces ADD ...`). Inspect it — it must be additive only, no
table rebuild that drops data.

- [ ] **Step 3: Verify the test DB still boots**

Run: `npm test -w apps/api -- workspaces`
Expected: PASS — existing workspace tests still green (new columns default to
`null` and are absent from responses only until Task 3 wires them in; the
`workspaceSchema.safeParse` test will FAIL here because the service does not yet
return the fields — that is expected and fixed in Task 3, so this step only
confirms the migration applies without a boot/SQL error).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "Sprint 36.1: workspaces.website_url + onboarding_step columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Workspace service + onboarding route

**Files:**
- Modify: `apps/api/src/services/workspaces.ts`
- Modify: `apps/api/src/routes/workspaces.ts`
- Test: `apps/api/test/workspaces.test.ts`

**Interfaces consumed:** `createWorkspaceInputSchema` (now with `websiteUrl`,
`onboardingStep`), `ONBOARDING_CURSORS`.
**Interfaces produced:** `createWorkspace` returns `websiteUrl`/`onboardingStep`;
`advanceOnboarding(db, id, step): Workspace | undefined`;
`PATCH /workspaces/:id/onboarding { step }`.

- [ ] **Step 1: Write the failing tests** — append to `apps/api/test/workspaces.test.ts`:

```ts
  it("persists websiteUrl and defaults onboardingStep to null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Hexalog", websiteUrl: "https://hexalog.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(workspaceSchema.safeParse(body).success).toBe(true);
    expect(body.websiteUrl).toBe("https://hexalog.com");
    expect(body.onboardingStep).toBeNull();

    const got = await app.inject({ method: "GET", url: `/workspaces/${body.id}` });
    expect(got.json().websiteUrl).toBe("https://hexalog.com");
  });

  it("accepts an onboardingStep cursor at create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Cursored", websiteUrl: "https://a.co", onboardingStep: "connect" },
    });
    expect(res.json().onboardingStep).toBe("connect");
  });

  it("rejects a bad websiteUrl with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Bad", websiteUrl: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });

  it("advances the onboarding cursor", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Flow" } })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${created.id}/onboarding`,
      payload: { step: "verify" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboardingStep).toBe("verify");
  });

  it("rejects an unknown onboarding step with 400", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Flow2" } })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${created.id}/onboarding`,
      payload: { step: "banana" },
    });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w apps/api -- workspaces`
Expected: FAIL — `websiteUrl` missing from responses; `PATCH …/onboarding` 404.

- [ ] **Step 3: Implement the service** — `apps/api/src/services/workspaces.ts`

Extend `createWorkspace` to persist and return the new columns:

```ts
export function createWorkspace(
  db: Db,
  input: CreateWorkspaceInput,
  ownerId?: string | null,
): Workspace {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: input.name,
    websiteUrl: input.websiteUrl ?? null,
    onboardingStep: input.onboardingStep ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workspaces).values(row).run();
  ensureBrainDocs(db, row.id);
  if (ownerId) {
    db.insert(workspaceMembers)
      .values({ id: randomUUID(), workspaceId: row.id, userId: ownerId, role: "owner", createdAt: now })
      .run();
  }
  return row;
}
```

In `listWorkspacesForUser`, the explicit column projection must include the two
new fields (so list items satisfy `workspaceSchema`):

```ts
    .select({
      id: workspaces.id,
      name: workspaces.name,
      websiteUrl: workspaces.websiteUrl,
      onboardingStep: workspaces.onboardingStep,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
```

(`listWorkspaces` and `getWorkspace` use `select().from(workspaces)` — all
columns already — no change.)

Add the cursor mutator at the end of the file:

```ts
/** Move a workspace's onboarding cursor. Returns undefined if it doesn't exist. */
export function advanceOnboarding(
  db: Db,
  id: string,
  step: OnboardingCursor,
): Workspace | undefined {
  const now = Date.now();
  db.update(workspaces)
    .set({ onboardingStep: step, updatedAt: now })
    .where(eq(workspaces.id, id))
    .run();
  return getWorkspace(db, id);
}
```

Add `OnboardingCursor` to the `@tuezday/contracts` import and keep the existing
`eq` import (already present).

- [ ] **Step 4: Implement the route** — in `apps/api/src/routes/workspaces.ts`,
  import `advanceOnboarding` and `ONBOARDING_CURSORS`, and add inside
  `registerWorkspaceRoutes`:

```ts
  app.patch<{ Params: { id: string }; Body: { step?: string } }>(
    "/workspaces/:id/onboarding",
    async (request, reply) => {
      const step = request.body?.step;
      if (!step || !ONBOARDING_CURSORS.includes(step as never)) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `step must be one of: ${ONBOARDING_CURSORS.join(", ")}`,
        });
      }
      const updated = advanceOnboarding(db, request.params.id, step as OnboardingCursor);
      if (!updated) return reply.status(404).send({ error: "workspace_not_found" });
      return updated;
    },
  );
```

Import `ONBOARDING_CURSORS` and the `OnboardingCursor` type from
`@tuezday/contracts` at the top of the routes file. (Membership on
`/workspaces/:id/...` is already enforced by the guard.)

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -w apps/api -- workspaces`
Expected: PASS — all prior + 5 new tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/workspaces.ts apps/api/src/routes/workspaces.ts apps/api/test/workspaces.test.ts
git commit -m "Sprint 36.1: workspace stores website URL + onboarding cursor route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: User name update — `PATCH /auth/me`

**Files:**
- Modify: `apps/api/src/services/auth.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces produced:** `updateUserName(db, id, name): User | undefined`;
`PATCH /auth/me { name }` → `{ user }`.

- [ ] **Step 1: Write the failing tests** — append to `apps/api/test/auth.test.ts`
  (mirror that file's existing setup; register a user, then):

```ts
  it("updates the signed-in user's name", async () => {
    const user = await registerUser(app, "namer@test.dev", "Old");
    const authed = asUser(app, user.token);
    const res = await authed.inject({
      method: "PATCH",
      url: "/auth/me",
      payload: { name: "  New Name  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBe("New Name");

    const me = await authed.inject({ method: "GET", url: "/auth/me" });
    expect(me.json().user.name).toBe("New Name");
  });

  it("rejects an empty name with 400", async () => {
    const user = await registerUser(app, "empty@test.dev", "Keep");
    const authed = asUser(app, user.token);
    const res = await authed.inject({ method: "PATCH", url: "/auth/me", payload: { name: "  " } });
    expect(res.statusCode).toBe(400);
  });
```

Ensure the test file imports `asUser` and `registerUser` from `./helpers` and
builds a raw `app` via `buildApp` (not pre-authed) if it doesn't already — match
the file's existing pattern; if it uses `buildAuthedApp`, add a second raw `app`
or reuse `registerUser` against the underlying instance as the other tests there do.

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w apps/api -- auth`
Expected: FAIL — `PATCH /auth/me` returns 404/405.

- [ ] **Step 3: Implement the service** — add to `apps/api/src/services/auth.ts`:

```ts
export function updateUserName(db: Db, id: string, name: string): User | undefined {
  const now = Date.now();
  db.update(users).set({ name, updatedAt: now }).where(eq(users.id, id)).run();
  return getUser(db, id);
}
```

(`users`, `eq`, `getUser`, and the `User` type are already imported in this file.)

- [ ] **Step 4: Implement the route** — in `apps/api/src/routes/auth.ts`, import
  `updateUserInputSchema` from `@tuezday/contracts` and `updateUserName` from
  `../services/auth`, then add inside `registerAuthRoutes` (right after the
  `GET /auth/me` handler):

```ts
  app.patch("/auth/me", async (request, reply) => {
    if (request.actor.system || !request.actor.userId) {
      return reply.status(403).send({ error: "system_actor" });
    }
    const parsed = updateUserInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const user = updateUserName(db, request.actor.userId, parsed.data.name);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    return { user };
  });
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -w apps/api -- auth`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auth.ts apps/api/src/routes/auth.ts apps/api/test/auth.test.ts
git commit -m "Sprint 36.1: PATCH /auth/me to set the user's name

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Onboarding wizard UI

**Files:**
- Create: `apps/web/app/onboarding/page.tsx`
- Create: `apps/web/app/onboarding/onboarding.css`
- Modify: `apps/web/app/page.tsx`

No automated tests (web has no runner) — this task ends with a **manual
verification** step. Keep all branching trivial; the tested logic (step
vocabulary, URL validation) already lives in contracts.

- [ ] **Step 1: Build the wizard** — `apps/web/app/onboarding/page.tsx`. A client
  component with a local `step` cursor over `ONBOARDING_STEPS`. Behaviour:
  - `name` step: text input → on continue, `PATCH /auth/me { name }`, store the
    name in state, advance to `website`. Greet ("Nice to meet you, {name}.") on
    every subsequent step.
  - `website` step: URL input (validate with `createWorkspaceInputSchema`'s rule
    client-side — a simple `new URL()` try/catch is enough) → on continue,
    `POST /workspaces { name: <derived>, websiteUrl, onboardingStep: "connect" }`.
    Derive the workspace name from the URL host (e.g. `hexalog.com` → `Hexalog`)
    unless the user typed one; keep it editable. Store the returned workspace id.
  - `connect`, `verify`, `brain`, `campaign`, `draft`: render a placeholder
    `.panel` with the step title, a one-line "Coming up in a later sprint" note,
    and (for `connect` onward) a disabled Continue — EXCEPT a always-available
    "Skip to workspace" link that routes to `/workspaces/{id}` so the flow is
    walkable end-to-end today.
  - A progress rail across the top listing all seven `ONBOARDING_STEPS` with the
    current one highlighted (map over the imported const — never hard-code labels).
  - Reuse `apiFetch`/`getToken` from `@/lib/api`; redirect to `/login` if no token
    (same guard as `app/page.tsx`). Wrap content in `.module-in` for the fade-in.

  Full reference implementation:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ONBOARDING_STEPS, type OnboardingStep } from "@tuezday/contracts";
import { apiFetch, getToken } from "@/lib/api";
import "./onboarding.css";

const STEP_LABELS: Record<OnboardingStep, string> = {
  name: "You",
  website: "Website",
  connect: "Socials",
  verify: "Verify",
  brain: "Your Brain",
  campaign: "Campaign",
  draft: "First draft",
};

function nameFromHost(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const bare = host.split(".")[0] ?? host;
    return bare.charAt(0).toUpperCase() + bare.slice(1);
  } catch {
    return "";
  }
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>("name");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [wsName, setWsName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) router.push("/login");
  }, [router]);

  const validUrl = useMemo(() => {
    try {
      const u = new URL(website);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, [website]);

  async function saveName() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? "Could not save your name");
      setStep("website");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: (wsName || nameFromHost(website) || "My workspace").trim(),
          websiteUrl: website.trim(),
          onboardingStep: "connect",
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? "Could not create the workspace");
      setWorkspaceId(body.id);
      setStep("connect");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding module-in">
      <ol className="ob-rail">
        {ONBOARDING_STEPS.map((s) => (
          <li key={s} className={`ob-rail-step ${s === step ? "active" : ""}`}>
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      {name && step !== "name" && <p className="ob-greeting">Nice to meet you, {name}.</p>}
      {error && <p className="error">{error}</p>}

      {step === "name" && (
        <section className="panel ob-panel">
          <h1>Welcome to Tuezday</h1>
          <p className="subtitle">First — what should we call you?</p>
          <input
            className="ob-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={100}
            autoFocus
          />
          <button disabled={busy || name.trim().length === 0} onClick={saveName}>
            {busy ? "Saving…" : "Continue"}
          </button>
        </section>
      )}

      {step === "website" && (
        <section className="panel ob-panel">
          <h1>Point us at your website</h1>
          <p className="subtitle">
            We&apos;ll read it to draft your brain. (Reading starts in a later sprint —
            for now we just remember it.)
          </p>
          <input
            className="ob-input"
            value={website}
            onChange={(e) => {
              setWebsite(e.target.value);
              if (!wsName) setWsName(nameFromHost(e.target.value));
            }}
            placeholder="https://acme.com"
            autoFocus
          />
          <input
            className="ob-input"
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="Workspace name"
            maxLength={100}
          />
          <div className="ob-actions">
            <button className="link-button" onClick={() => setStep("name")}>Back</button>
            <button disabled={busy || !validUrl} onClick={createWorkspace}>
              {busy ? "Creating…" : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step !== "name" && step !== "website" && (
        <section className="panel ob-panel">
          <h1>{STEP_LABELS[step]}</h1>
          <p className="subtitle">Coming up in a later sprint.</p>
          {workspaceId && (
            <Link className="link-button" href={`/workspaces/${workspaceId}`}>
              Skip to workspace →
            </Link>
          )}
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Style it** — `apps/web/app/onboarding/onboarding.css`, on native
  tokens (no Tailwind). Minimum viable, matching the app's look:

```css
.onboarding { max-width: 640px; margin: 0 auto; padding: 2rem 1rem; }
.ob-rail { display: flex; gap: 0.5rem; list-style: none; padding: 0; margin: 0 0 1.5rem; flex-wrap: wrap; }
.ob-rail-step { font-size: 0.8rem; padding: 0.25rem 0.6rem; border-radius: 999px; background: var(--panel, #f4f4f5); color: var(--muted, #71717a); }
.ob-rail-step.active { background: var(--accent, oklch(0.6 0.2 260)); color: #fff; }
.ob-greeting { color: var(--muted, #71717a); margin-bottom: 0.75rem; }
.ob-panel { display: flex; flex-direction: column; gap: 0.75rem; }
.ob-input { padding: 0.6rem 0.75rem; border: 1px solid var(--border, #e4e4e7); border-radius: 0.5rem; font: inherit; }
.ob-actions { display: flex; justify-content: space-between; align-items: center; }
```

(If `globals.css` already defines `--accent`/`--border`/`--muted`/`--panel`,
those win; the fallbacks only guard against a missing token.)

- [ ] **Step 3: Route into it from home** — in `apps/web/app/page.tsx`, above the
  existing `<form className="create-form">`, add a primary call-to-action and
  demote the inline form to a secondary "advanced" affordance:

```tsx
      <div className="create-form">
        <button type="button" onClick={() => router.push("/onboarding")}>
          Start guided setup
        </button>
      </div>
      <details className="quick-create">
        <summary>Quick create (skip onboarding)</summary>
        {/* existing <form className="create-form" onSubmit={createWorkspace}> ... </form> stays here unchanged */}
      </details>
```

Keep the existing `createWorkspace` handler and form exactly as-is inside the
`<details>` — this is the dev/escape hatch that keeps current behaviour working.
`router` is already available (the file imports `useRouter`).

- [ ] **Step 4: Manual verification** (web has no test runner)

```bash
npm run dev
```

Then in the browser at `http://localhost:3000`:
1. Log in → home shows **Start guided setup**.
2. Click it → `/onboarding`, step rail shows all 7 steps, "You" active.
3. Enter a name → Continue → greeting "Nice to meet you, {name}." appears, rail
   advances to "Website".
4. Enter `https://acme.com` → workspace name auto-fills "Acme" → Continue.
5. Land on the `connect` placeholder → **Skip to workspace →** opens
   `/workspaces/{id}`; the workspace exists.
6. Reload home → the new workspace is listed. **Quick create** still works via
   the `<details>`.
7. Confirm the header/app greets by the saved name (existing `/auth/me` usage in
   `app/page.tsx` already renders `user.name`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/onboarding apps/web/app/page.tsx
git commit -m "Sprint 36.1: onboarding wizard shell (name + website steps)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full green + progress log

- [ ] **Step 1: Whole suite + typecheck + web build**

```bash
npm test
npm run typecheck
npm run build -w apps/web
```
Expected: all green. If the web build flags the `useRouter` import already
present, no action; if it flags an unused import, remove it.

- [ ] **Step 2: Update this file's Progress log** (below) with commit SHAs.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin sprint-36-1-onboarding-shell
```

Do NOT open a PR into `main` or merge — the founder reviews and merges.

---

## Founder acceptance

Sign in → **Start guided setup** greets you by name → enter your website URL →
a workspace is created carrying that URL (verify via `GET /workspaces/:id` →
`websiteUrl` set, `onboardingStep: "connect"`) → you can walk the rest of the
rail as placeholders and land in the workspace. Quick-create still works.

## Out of scope (deferred to later 36.x)

- Any actual scraping / social connect / brain draft / campaign / first draft —
  those are sprints 36.2–36.6. Here they are placeholder panels only.
- Persisting the wizard's position across reloads (the cursor is stored on the
  workspace via `onboardingStep`, but resuming into the right step is a 36.5
  concern once the middle steps are real).
- Forcing onboarding on every new workspace (founder wants this eventually; in
  36.1 it is opt-in via "Start guided setup" so the escape hatch de-risks the
  incremental build — flip the default in 36.6 when the flow is complete).

## Progress log

- 2026-07-06 — Spec + plan written (this file). Awaiting founder review before
  implementation.
