# Persona Account Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build persona-aware social account routing so multiple accounts per provider can be connected and safely assigned to personas.

**Architecture:** Keep `connections` as the credential and health source of truth. Add `persona_social_accounts` as the routing policy table. Route every social dispatch decision through a shared resolver before publishing, filling cadences, launching broadcasts, or sending X DMs.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, SQLite migrations with later Postgres portability, Zod contracts, Vitest, Next.js App Router.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: add connection identity fields, social account assignment schemas, and new input schemas.
- Modify `apps/api/src/db/schema.ts`: add connection metadata columns and the `personaSocialAccounts` table.
- Generate `apps/api/drizzle/0026_*.sql`: generated migration from Drizzle after schema changes.
- Modify `apps/api/src/services/connections.ts`: allow multiple connections per provider, add display-name patching, refresh identity metadata.
- Create `apps/api/src/services/persona-social-accounts.ts`: assignment CRUD, primary enforcement, and routing resolver.
- Modify `apps/api/src/routes/connectors.ts`: multiple account OAuth completion, connection patch route, provider response shape stays compatible.
- Modify `apps/api/src/routes/personas.ts`: assignment routes under persona.
- Modify `apps/api/src/routes/publications.ts`: enforce persona-account assignment for persona drafts.
- Modify `apps/api/src/routes/cadences.ts`: resolve or validate cadence connection against persona.
- Modify `apps/api/src/services/cadences.ts`: keep storing concrete `connectionId`; no connector call changes.
- Modify `apps/api/src/services/launches.ts`: route launch dispatch and X DMs through persona account resolver.
- Modify `apps/web/app/workspaces/[id]/connectors/page.tsx`: show multiple accounts per provider.
- Modify `apps/web/app/workspaces/[id]/cadence/page.tsx`: filter account picker by selected persona where possible.
- Modify `apps/web/app/workspaces/[id]/launches/page.tsx`: show selected persona channel readiness.
- Add or modify tests in `apps/api/test/connect-social.test.ts`, `apps/api/test/personas.test.ts`, `apps/api/test/publish.test.ts`, `apps/api/test/cadences.test.ts`, and `apps/api/test/launches.test.ts`.

---

### Task 1: Contracts For Multi-Account Connections And Persona Assignments

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add these assertions to `packages/contracts/test/contracts.test.ts`:

```ts
import {
  connectionSchema,
  personaSocialAccountSchema,
  upsertPersonaSocialAccountInputSchema,
  SOCIAL_ACCOUNT_CHANNELS,
} from "../src";

it("parses connection identity metadata", () => {
  expect(
    connectionSchema.parse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "7c9e6679-7425-40de-944b-e07fc1f90ae8",
      providerKey: "linkedin",
      nangoConnectionId: "nango-linkedin-a",
      config: {},
      displayName: "Founder LinkedIn",
      externalAccountId: "person-123",
      externalAccountName: "Founder Name",
      externalAccountHandle: "founder",
      externalAccountUrl: "https://linkedin.com/in/founder",
      status: "connected",
      lastCheckedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }).displayName,
  ).toBe("Founder LinkedIn");
});

it("parses persona social account assignments", () => {
  expect(SOCIAL_ACCOUNT_CHANNELS).toContain("linkedin");
  expect(
    personaSocialAccountSchema.parse({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      workspaceId: "7c9e6679-7425-40de-944b-e07fc1f90ae8",
      personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae9",
      connectionId: "7c9e6679-7425-40de-944b-e07fc1f90aea",
      providerKey: "linkedin",
      channel: "linkedin",
      isPrimary: true,
      defaultTarget: "feed",
      createdAt: 1,
      updatedAt: 1,
    }).isPrimary,
  ).toBe(true);
  expect(
    upsertPersonaSocialAccountInputSchema.parse({
      connectionId: "7c9e6679-7425-40de-944b-e07fc1f90aea",
      channel: "linkedin",
      isPrimary: true,
    }).defaultTarget,
  ).toBe("feed");
});
```

- [ ] **Step 2: Run the contract tests and verify they fail**

Run: `npm test -- contracts -t "persona social account"`

Expected: fail because `personaSocialAccountSchema`, `upsertPersonaSocialAccountInputSchema`, and `SOCIAL_ACCOUNT_CHANNELS` are not exported.

- [ ] **Step 3: Add contracts**

In `packages/contracts/src/index.ts`, extend `connectionSchema`:

```ts
export const connectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  providerKey: z.string(),
  nangoConnectionId: z.string(),
  config: z.object({
    baseUrl: z.string().optional(),
    testPath: z.string().optional(),
  }),
  displayName: z.string(),
  externalAccountId: z.string().nullable(),
  externalAccountName: z.string().nullable(),
  externalAccountHandle: z.string().nullable(),
  externalAccountUrl: z.string().nullable(),
  status: z.enum(CONNECTION_STATUSES),
  lastCheckedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Connection = z.infer<typeof connectionSchema>;
```

Add this block after connection contracts:

```ts
export const SOCIAL_ACCOUNT_CHANNELS = ["linkedin", "instagram", "x", "reddit"] as const;
export type SocialAccountChannel = (typeof SOCIAL_ACCOUNT_CHANNELS)[number];

export const personaSocialAccountSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  personaId: z.string().uuid(),
  connectionId: z.string().uuid(),
  providerKey: z.string(),
  channel: z.enum(SOCIAL_ACCOUNT_CHANNELS),
  isPrimary: z.boolean(),
  defaultTarget: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PersonaSocialAccount = z.infer<typeof personaSocialAccountSchema>;

export const upsertPersonaSocialAccountInputSchema = z.object({
  connectionId: z.string().uuid(),
  channel: z.enum(SOCIAL_ACCOUNT_CHANNELS),
  isPrimary: z.boolean().default(false),
  defaultTarget: z.string().trim().min(1).max(200).default("feed"),
});
export type UpsertPersonaSocialAccountInput = z.infer<typeof upsertPersonaSocialAccountInputSchema>;

export const updateConnectionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
});
export type UpdateConnectionInput = z.infer<typeof updateConnectionInputSchema>;
```

- [ ] **Step 4: Run contract tests**

Run: `npm test -- contracts`

Expected: contracts tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/contracts.test.ts
git commit -m "feat: add persona social account contracts"
```

---

### Task 2: Database Schema And Migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated `apps/api/drizzle/0026_*.sql`

- [ ] **Step 1: Add schema definitions**

In `apps/api/src/db/schema.ts`, extend `connections`:

```ts
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  providerKey: text("provider_key").notNull(),
  nangoConnectionId: text("nango_connection_id").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  displayName: text("display_name").notNull().default(""),
  externalAccountId: text("external_account_id"),
  externalAccountName: text("external_account_name"),
  externalAccountHandle: text("external_account_handle"),
  externalAccountUrl: text("external_account_url"),
  status: text("status").notNull().default("connected"),
  lastCheckedAt: integer("last_checked_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

Add this table after `connections`:

```ts
export const personaSocialAccounts = sqliteTable(
  "persona_social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    channel: text("channel").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    defaultTarget: text("default_target").notNull().default("feed"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("persona_social_accounts_unique").on(table.personaId, table.connectionId, table.channel),
  ],
);

export type PersonaSocialAccountRow = typeof personaSocialAccounts.$inferSelect;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate -w apps/api`

Expected: Drizzle creates the next migration under `apps/api/drizzle/` and updates `apps/api/drizzle/meta/_journal.json`.

- [ ] **Step 3: Verify migration contains the intended changes**

Run: `git diff -- apps/api/drizzle apps/api/src/db/schema.ts`

Expected: diff includes new `connections` columns and `CREATE TABLE persona_social_accounts`.

- [ ] **Step 4: Run API tests once to catch migration boot failures**

Run: `npm test -- api -t "health"`

Expected: health tests pass and in-memory DB creation succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat: add persona social account schema"
```

---

### Task 3: Connection Service Supports Multiple Accounts Per Provider

**Files:**
- Modify: `apps/api/src/services/connections.ts`
- Modify: `apps/api/src/routes/connectors.ts`
- Test: `apps/api/test/connect-social.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that connect two OAuth accounts for the same provider:

```ts
it("keeps multiple OAuth accounts for the same social provider", async () => {
  process.env.LINKEDIN_CLIENT_ID = "id";
  process.env.LINKEDIN_CLIENT_SECRET = "secret";

  const firstSession = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/session`,
  });
  expect(firstSession.statusCode).toBe(200);
  state.connections.set("nango-linkedin-a", {
    providerConfigKey: "tuezday-linkedin",
    credentials: {},
  });
  const first = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
    payload: { connectionId: "nango-linkedin-a" },
  });
  expect(first.statusCode).toBe(201);

  state.connections.set("nango-linkedin-b", {
    providerConfigKey: "tuezday-linkedin",
    credentials: {},
  });
  const second = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
    payload: { connectionId: "nango-linkedin-b" },
  });
  expect(second.statusCode).toBe(201);

  const view = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
  const linkedInConnections = view
    .json()
    .connections.filter((c: { providerKey: string }) => c.providerKey === "linkedin");
  expect(linkedInConnections).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- api -t "keeps multiple OAuth accounts"`

Expected: fail because the second OAuth completion overwrites the first LinkedIn row.

- [ ] **Step 3: Update `rowToConnection` and row creation**

In `apps/api/src/services/connections.ts`, return the new fields:

```ts
function rowToConnection(row: ConnectionRow): Connection {
  return {
    ...row,
    displayName: row.displayName || row.providerKey,
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    externalAccountHandle: row.externalAccountHandle,
    externalAccountUrl: row.externalAccountUrl,
    updatedAt: row.updatedAt ?? row.createdAt,
    config: JSON.parse(row.configJson) as Connection["config"],
    status: row.status as ConnectionStatus,
  };
}
```

When creating connection rows, set:

```ts
displayName: provider.label,
externalAccountId: null,
externalAccountName: null,
externalAccountHandle: null,
externalAccountUrl: null,
updatedAt: now,
```

- [ ] **Step 4: Make OAuth completion idempotent by Nango connection ID**

Replace the provider-level lookup in `registerOAuthConnection` with:

```ts
const existing = db
  .select()
  .from(connections)
  .where(
    and(
      eq(connections.workspaceId, workspaceId),
      eq(connections.nangoConnectionId, nangoConnectionId),
    ),
  )
  .get();
```

Do not look up by `providerKey` in `registerOAuthConnection`.

- [ ] **Step 5: Make token-paste connection IDs unique per account**

In `connectProvider`, replace:

```ts
const nangoConnectionId = `ws-${workspaceId}-${provider.key}`;
```

with:

```ts
const nangoConnectionId = `ws-${workspaceId}-${provider.key}-${randomUUID()}`;
```

Remove the provider-level `existing` update path from `connectProvider`. Reconnect now means a new connection row unless the UI explicitly reconnects a disconnected row in a future scoped flow.

- [ ] **Step 6: Add connection display-name patch route**

In `apps/api/src/routes/connectors.ts`, add:

```ts
app.patch<{ Params: { id: string; connectionId: string } }>(
  "/workspaces/:id/connections/:connectionId",
  async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = updateConnectionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const updated = updateConnection(db, request.params.id, request.params.connectionId, parsed.data);
    if (!updated) return reply.status(404).send({ error: "connection_not_found" });
    return updated;
  },
);
```

Add `updateConnection` to `apps/api/src/services/connections.ts`:

```ts
export function updateConnection(
  db: Db,
  workspaceId: string,
  connectionId: string,
  input: UpdateConnectionInput,
): Connection | undefined {
  const existing = getConnection(db, workspaceId, connectionId);
  if (!existing) return undefined;
  db.update(connections)
    .set({ displayName: input.displayName, updatedAt: Date.now() })
    .where(eq(connections.id, connectionId))
    .run();
  return getConnection(db, workspaceId, connectionId);
}
```

- [ ] **Step 7: Run tests**

Run: `npm test -- api -t "connect"`

Expected: connector and connect-social tests pass after updating assertions that expected one connection per provider.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/connections.ts apps/api/src/routes/connectors.ts apps/api/test/connect-social.test.ts
git commit -m "feat: support multiple social connections per provider"
```

---

### Task 4: Persona Social Account Service And Routes

**Files:**
- Create: `apps/api/src/services/persona-social-accounts.ts`
- Modify: `apps/api/src/routes/personas.ts`
- Test: `apps/api/test/personas.test.ts`

- [ ] **Step 1: Write failing persona assignment tests**

Add tests in `apps/api/test/personas.test.ts`:

```ts
it("assigns connected social accounts to a persona and enforces one primary", async () => {
  const persona = await createPersona("CEO");
  const first = await connectSocial("linkedin", "nango-linkedin-a");
  const second = await connectSocial("linkedin", "nango-linkedin-b");

  const a = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
    payload: { connectionId: first.id, channel: "linkedin", isPrimary: true },
  });
  expect(a.statusCode).toBe(201);

  const b = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
    payload: { connectionId: second.id, channel: "linkedin", isPrimary: true },
  });
  expect(b.statusCode).toBe(201);

  const list = await app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
  });
  const assignments = list.json();
  expect(assignments.filter((x: { isPrimary: boolean }) => x.isPrimary)).toHaveLength(1);
  expect(assignments.find((x: { connectionId: string }) => x.connectionId === second.id).isPrimary).toBe(true);
});
```

- [ ] **Step 2: Run the persona test and verify it fails**

Run: `npm test -- api -t "assigns connected social accounts"`

Expected: fail because assignment routes do not exist.

- [ ] **Step 3: Create service**

Create `apps/api/src/services/persona-social-accounts.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  PersonaSocialAccount,
  SocialAccountChannel,
  UpsertPersonaSocialAccountInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { personaSocialAccounts, type PersonaSocialAccountRow } from "../db/schema";
import { getConnection, providerByKey } from "./connections";

function rowToAssignment(row: PersonaSocialAccountRow): PersonaSocialAccount {
  return {
    ...row,
    channel: row.channel as SocialAccountChannel,
    isPrimary: Boolean(row.isPrimary),
  };
}

export function listPersonaSocialAccounts(
  db: Db,
  workspaceId: string,
  personaId: string,
): PersonaSocialAccount[] {
  return db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
      ),
    )
    .all()
    .map(rowToAssignment);
}

function demotePrimary(
  db: Db,
  workspaceId: string,
  personaId: string,
  providerKey: string,
  channel: string,
): void {
  db.update(personaSocialAccounts)
    .set({ isPrimary: false, updatedAt: Date.now() })
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.providerKey, providerKey),
        eq(personaSocialAccounts.channel, channel),
      ),
    )
    .run();
}

export type AssignmentResult =
  | { ok: true; assignment: PersonaSocialAccount }
  | { ok: false; error: "connection_not_found" | "not_social" };

export function createPersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  input: UpsertPersonaSocialAccountInput,
): AssignmentResult {
  const connection = getConnection(db, workspaceId, input.connectionId);
  if (!connection) return { ok: false, error: "connection_not_found" };
  const provider = providerByKey(connection.providerKey);
  if (!provider?.categories?.includes("social")) return { ok: false, error: "not_social" };
  if (input.isPrimary) {
    demotePrimary(db, workspaceId, personaId, connection.providerKey, input.channel);
  }
  const now = Date.now();
  const row: PersonaSocialAccountRow = {
    id: randomUUID(),
    workspaceId,
    personaId,
    connectionId: connection.id,
    providerKey: connection.providerKey,
    channel: input.channel,
    isPrimary: input.isPrimary,
    defaultTarget: input.defaultTarget,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(personaSocialAccounts).values(row).run();
  return { ok: true, assignment: rowToAssignment(row) };
}
```

- [ ] **Step 4: Add update and delete helpers**

Add:

```ts
export function updatePersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  assignmentId: string,
  input: UpsertPersonaSocialAccountInput,
): AssignmentResult | { ok: false; error: "assignment_not_found" } {
  const existing = db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .get();
  if (!existing) return { ok: false, error: "assignment_not_found" };
  const connection = getConnection(db, workspaceId, input.connectionId);
  if (!connection) return { ok: false, error: "connection_not_found" };
  const provider = providerByKey(connection.providerKey);
  if (!provider?.categories?.includes("social")) return { ok: false, error: "not_social" };
  if (input.isPrimary) {
    demotePrimary(db, workspaceId, personaId, connection.providerKey, input.channel);
  }
  db.update(personaSocialAccounts)
    .set({
      connectionId: connection.id,
      providerKey: connection.providerKey,
      channel: input.channel,
      isPrimary: input.isPrimary,
      defaultTarget: input.defaultTarget,
      updatedAt: Date.now(),
    })
    .where(eq(personaSocialAccounts.id, assignmentId))
    .run();
  return {
    ok: true,
    assignment: listPersonaSocialAccounts(db, workspaceId, personaId).find((a) => a.id === assignmentId)!,
  };
}

export function deletePersonaSocialAccount(
  db: Db,
  workspaceId: string,
  personaId: string,
  assignmentId: string,
): boolean {
  const existing = db
    .select()
    .from(personaSocialAccounts)
    .where(
      and(
        eq(personaSocialAccounts.workspaceId, workspaceId),
        eq(personaSocialAccounts.personaId, personaId),
        eq(personaSocialAccounts.id, assignmentId),
      ),
    )
    .get();
  if (!existing) return false;
  db.delete(personaSocialAccounts).where(eq(personaSocialAccounts.id, assignmentId)).run();
  return true;
}
```

- [ ] **Step 5: Add routes**

In `apps/api/src/routes/personas.ts`, import the schema and service functions, then add routes after persona CRUD:

```ts
app.get<{ Params: { id: string; personaId: string } }>(
  "/workspaces/:id/personas/:personaId/social-accounts",
  async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    if (!getPersona(db, request.params.id, request.params.personaId)) {
      return reply.status(404).send({ error: "persona_not_found" });
    }
    return listPersonaSocialAccounts(db, request.params.id, request.params.personaId);
  },
);

app.post<{ Params: { id: string; personaId: string } }>(
  "/workspaces/:id/personas/:personaId/social-accounts",
  async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    if (!getPersona(db, request.params.id, request.params.personaId)) {
      return reply.status(404).send({ error: "persona_not_found" });
    }
    const parsed = upsertPersonaSocialAccountInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const result = createPersonaSocialAccount(db, request.params.id, request.params.personaId, parsed.data);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    return reply.status(201).send(result.assignment);
  },
);
```

Add matching `PATCH` and `DELETE` routes using `updatePersonaSocialAccount` and `deletePersonaSocialAccount`.

- [ ] **Step 6: Run persona tests**

Run: `npm test -- api -t "persona"`

Expected: persona CRUD and assignment tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/persona-social-accounts.ts apps/api/src/routes/personas.ts apps/api/test/personas.test.ts
git commit -m "feat: map social accounts to personas"
```

---

### Task 5: Shared Persona Account Routing Resolver

**Files:**
- Modify: `apps/api/src/services/persona-social-accounts.ts`
- Test: `apps/api/test/personas.test.ts`

- [ ] **Step 1: Write resolver tests**

Add tests for primary routing, mismatch, and missing account:

```ts
it("resolves a persona primary account and rejects mismatched explicit accounts", async () => {
  const persona = await createPersona("CEO");
  const ceoAccount = await connectSocial("linkedin", "nango-linkedin-ceo");
  const otherAccount = await connectSocial("linkedin", "nango-linkedin-other");
  await assign(persona.id, ceoAccount.id, "linkedin", true);

  expect(
    resolvePersonaSocialConnection(db, workspaceId, {
      personaId: persona.id,
      providerKey: "linkedin",
      channel: "linkedin",
    }).connection?.id,
  ).toBe(ceoAccount.id);

  expect(
    resolvePersonaSocialConnection(db, workspaceId, {
      personaId: persona.id,
      providerKey: "linkedin",
      channel: "linkedin",
      explicitConnectionId: otherAccount.id,
    }).error,
  ).toBe("persona_account_mismatch");
});
```

- [ ] **Step 2: Add resolver**

In `apps/api/src/services/persona-social-accounts.ts`, add:

```ts
export type PersonaAccountRoutingError =
  | "persona_account_missing"
  | "persona_account_mismatch"
  | "persona_account_unavailable"
  | "persona_account_ambiguous"
  | "connection_not_found";

export type PersonaConnectionResolution =
  | { ok: true; connection: Connection; assignment: PersonaSocialAccount | null }
  | { ok: false; error: PersonaAccountRoutingError };

export function providerForSocialChannel(channel: string): string | null {
  if (channel === "linkedin") return "linkedin";
  if (channel === "instagram") return "instagram";
  if (channel === "x") return "twitter";
  if (channel === "reddit") return "reddit";
  return null;
}

export function resolvePersonaSocialConnection(
  db: Db,
  workspaceId: string,
  args: {
    personaId: string | null | undefined;
    providerKey?: string;
    channel: string;
    explicitConnectionId?: string;
  },
): PersonaConnectionResolution {
  const providerKey = args.providerKey ?? providerForSocialChannel(args.channel);
  if (!providerKey) return { ok: false, error: "persona_account_missing" };

  if (args.explicitConnectionId) {
    const connection = getConnection(db, workspaceId, args.explicitConnectionId);
    if (!connection) return { ok: false, error: "connection_not_found" };
    const provider = providerByKey(connection.providerKey);
    if (connection.status !== "connected" || connection.providerKey !== providerKey || !provider?.categories?.includes("social")) {
      return { ok: false, error: "persona_account_unavailable" };
    }
    if (!args.personaId) return { ok: true, connection, assignment: null };
    const assignment = listPersonaSocialAccounts(db, workspaceId, args.personaId).find(
      (a) => a.connectionId === connection.id && a.providerKey === providerKey && a.channel === args.channel,
    );
    if (!assignment) return { ok: false, error: "persona_account_mismatch" };
    return { ok: true, connection, assignment };
  }

  if (!args.personaId) return { ok: false, error: "persona_account_missing" };
  const primaries = listPersonaSocialAccounts(db, workspaceId, args.personaId).filter(
    (a) => a.providerKey === providerKey && a.channel === args.channel && a.isPrimary,
  );
  if (primaries.length === 0) return { ok: false, error: "persona_account_missing" };
  if (primaries.length > 1) return { ok: false, error: "persona_account_ambiguous" };
  const connection = getConnection(db, workspaceId, primaries[0]!.connectionId);
  const provider = connection ? providerByKey(connection.providerKey) : undefined;
  if (!connection || connection.status !== "connected" || !provider?.categories?.includes("social")) {
    return { ok: false, error: "persona_account_unavailable" };
  }
  return { ok: true, connection, assignment: primaries[0]! };
}
```

- [ ] **Step 3: Run resolver tests**

Run: `npm test -- api -t "resolves a persona primary account"`

Expected: resolver tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/persona-social-accounts.ts apps/api/test/personas.test.ts
git commit -m "feat: resolve persona social accounts"
```

---

### Task 6: Enforce Persona Routing In Manual Publish And Cadences

**Files:**
- Modify: `apps/api/src/routes/publications.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/routes/cadences.ts`
- Test: `apps/api/test/publish.test.ts`
- Test: `apps/api/test/cadences.test.ts`

- [ ] **Step 1: Write publish mismatch test**

Add to `apps/api/test/publish.test.ts`:

```ts
it("blocks persona drafts from publishing through unassigned accounts", async () => {
  const persona = await createPersona("CEO");
  const assigned = await connectReddit("nango-reddit-ceo");
  const unassigned = await connectReddit("nango-reddit-other");
  await assignSocialAccount(persona.id, assigned.id, "reddit", true);
  const draftId = await approvedDraft({ personaId: persona.id, channel: "linkedin" });

  const res = await publish(draftId, {
    connectionId: unassigned.id,
    target: "test",
    title: "Wrong account",
  });

  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("persona_account_mismatch");
});
```

- [ ] **Step 2: Enforce publish routing**

In `apps/api/src/routes/publications.ts`, after loading and validating the connection, add:

```ts
if (draft.personaId) {
  const routed = resolvePersonaSocialConnection(db, request.params.id, {
    personaId: draft.personaId,
    providerKey: connection.providerKey,
    channel: provider.key === "twitter" ? "x" : provider.key,
    explicitConnectionId: connection.id,
  });
  if (!routed.ok) {
    return reply.status(409).send({
      error: routed.error,
      message: "This draft's persona is not assigned to the selected social account.",
    });
  }
}
```

- [ ] **Step 3: Make cadence `connectionId` optional in contracts**

In `createPostingCadenceInputSchema`, change:

```ts
connectionId: z.string().uuid(),
```

to:

```ts
connectionId: z.string().uuid().optional(),
```

Keep `postingCadenceSchema.connectionId` required because persisted cadences store the resolved account.

- [ ] **Step 4: Resolve cadence connection in route**

In `apps/api/src/routes/cadences.ts`, before `createCadence`, resolve:

```ts
let cadenceInput = parsed.data;
if (!cadenceInput.connectionId && cadenceInput.personaId) {
  const routed = resolvePersonaSocialConnection(db, request.params.id, {
    personaId: cadenceInput.personaId,
    channel: cadenceInput.channel,
  });
  if (!routed.ok) return reply.status(409).send({ error: routed.error });
  cadenceInput = { ...cadenceInput, connectionId: routed.connection.id };
}
if (!cadenceInput.connectionId) {
  return reply.status(400).send({ error: "connection_not_found", message: "Pick a social account or select a persona with a primary account." });
}
```

Pass `cadenceInput` to validation and `createCadence`.

- [ ] **Step 5: Add cadence auto-resolution test**

Add to `apps/api/test/cadences.test.ts`:

```ts
it("creates a persona cadence from the persona primary account", async () => {
  const persona = await createPersona("CEO");
  const account = await connectSocial("linkedin", "nango-linkedin-ceo");
  await assignSocialAccount(persona.id, account.id, "linkedin", true);
  const campaign = await createCampaign({ channels: ["linkedin"] });

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/cadences`,
    payload: {
      name: "CEO LinkedIn",
      campaignId: campaign.id,
      personaId: persona.id,
      channel: "linkedin",
      target: "feed",
      daysOfWeek: [1],
      timeOfDay: "09:00",
      timezone: "UTC",
    },
  });

  expect(res.statusCode).toBe(201);
  expect(res.json().connectionId).toBe(account.id);
});
```

- [ ] **Step 6: Run publish and cadence tests**

Run: `npm test -- api -t "persona"`

Expected: persona-related publish and cadence tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/routes/publications.ts apps/api/src/routes/cadences.ts apps/api/test/publish.test.ts apps/api/test/cadences.test.ts
git commit -m "feat: enforce persona account routing for publishing"
```

---

### Task 7: Route Launch Dispatch And X Sequences Through Persona Accounts

**Files:**
- Modify: `apps/api/src/services/launches.ts`
- Test: `apps/api/test/launches.test.ts`

- [ ] **Step 1: Write launch routing tests**

Add to `apps/api/test/launches.test.ts`:

```ts
it("dispatches LinkedIn launch broadcasts through the launch persona primary account", async () => {
  const persona = await createPersona("CEO");
  const ceoLinkedIn = await connectSocial("linkedin", "nango-linkedin-ceo");
  const otherLinkedIn = await connectSocial("linkedin", "nango-linkedin-other");
  await assignSocialAccount(persona.id, ceoLinkedIn.id, "linkedin", true);
  const launch = await readyLaunch({ personaId: persona.id, channels: ["linkedin"] });
  await approveLaunchDrafts(launch.id);

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/launches/${launch.id}/channels/linkedin/dispatch`,
    payload: {},
  });

  expect(res.statusCode).toBe(200);
  expect(publishedConnectionIds()).toEqual([ceoLinkedIn.id]);
  expect(publishedConnectionIds()).not.toContain(otherLinkedIn.id);
});
```

- [ ] **Step 2: Replace launch connection resolver**

In `apps/api/src/services/launches.ts`, update `resolveConnection` to accept persona and channel:

```ts
function resolveLaunchConnection(
  db: Db,
  workspaceId: string,
  launchRow: LaunchRow,
  channel: LaunchChannel,
  connectionId: string | undefined,
): ConnResolution {
  const providerKey = LAUNCH_CHANNEL_PROVIDER[channel];
  if (!providerKey) return { ok: false, error: "no_connection" };
  const routed = resolvePersonaSocialConnection(db, workspaceId, {
    personaId: launchRow.personaId,
    providerKey,
    channel,
    explicitConnectionId: connectionId,
  });
  if (routed.ok) return { ok: true, connection: routed.connection };
  if (routed.error === "persona_account_missing" && !launchRow.personaId) {
    return resolveConnection(db, workspaceId, providerKey, connectionId);
  }
  return { ok: false, error: routed.error === "persona_account_ambiguous" ? "ambiguous_connection" : "no_connection" };
}
```

Call `resolveLaunchConnection` from `dispatchChannel`.

- [ ] **Step 3: Store X DM connection ID on launch messages**

In the X DM success branch, change the update set to include:

```ts
connectionId: connection.id,
```

This makes per-connection caps and audits reliable for DMs.

- [ ] **Step 4: Run launch tests**

Run: `npm test -- api -t "launch"`

Expected: launch dispatch tests pass and existing explicit connection behavior still works.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/launches.ts apps/api/test/launches.test.ts
git commit -m "feat: route launches through persona accounts"
```

---

### Task 8: Web Surfaces For Multi-Account Routing

**Files:**
- Modify: `apps/web/app/workspaces/[id]/connectors/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/cadence/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/launches/page.tsx`
- Modify or create: persona account UI in the current persona surface under `apps/web/app/workspaces/[id]/brain/page.tsx` or the file that renders personas.

- [ ] **Step 1: Update Integrations account lookup**

Replace the single helper:

```ts
function connectionFor(providerKey: string): Connection | undefined {
  return view?.connections.find((c) => c.providerKey === providerKey);
}
```

with:

```ts
function connectionsFor(providerKey: string): Connection[] {
  return view?.connections.filter((c) => c.providerKey === providerKey) ?? [];
}
```

Render each provider with account rows:

```tsx
{connectionsFor(provider.key).map((connection) => (
  <div key={connection.id} className="section-card">
    <div className="section-head">
      <span className={`layer-badge ${connection.status === "connected" ? "state-approved" : "state-rejected"}`}>
        {connection.status}
      </span>
      <span className="section-title">{connection.displayName || provider.label}</span>
      {connection.externalAccountHandle && <span className="meta">@{connection.externalAccountHandle}</span>}
    </div>
    {connection.lastError && <p className="error">{connection.lastError}</p>}
    <div className="rating-row">
      <button className="button-secondary" disabled={busy} onClick={() => testConnection(connection)}>Test</button>
      <button className="button-secondary danger" disabled={busy} onClick={() => disconnect(connection)}>Disconnect</button>
    </div>
  </div>
))}
```

Change the OAuth button label to `Connect another account` when at least one connection exists for the provider.

- [ ] **Step 2: Add persona account assignment UI**

On the persona editing surface, load:

```ts
const [assignmentsRes, connectorsRes] = await Promise.all([
  apiFetch(`/workspaces/${id}/personas/${persona.id}/social-accounts`),
  apiFetch(`/workspaces/${id}/connectors`),
]);
```

Use this payload for assignment:

```ts
await apiFetch(`/workspaces/${id}/personas/${persona.id}/social-accounts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    connectionId,
    channel,
    isPrimary,
    defaultTarget: channel === "reddit" ? "test" : "feed",
  }),
});
```

- [ ] **Step 3: Filter cadence accounts by persona**

When `form.personaId` is selected, load that persona's assignments and filter `social` to those `connectionId`s. Keep all connected social accounts visible when no persona is selected.

- [ ] **Step 4: Show launch readiness**

In `launches/page.tsx`, when a persona is selected, show a channel as usable only when the provider is connected and the selected persona has a primary assignment for that channel. Keep email always usable.

- [ ] **Step 5: Run web typecheck**

Run: `npm run typecheck`

Expected: TypeScript passes across workspaces.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/workspaces/[id]/connectors/page.tsx apps/web/app/workspaces/[id]/cadence/page.tsx apps/web/app/workspaces/[id]/launches/page.tsx
git commit -m "feat: expose persona account routing in web"
```

---

### Task 9: Full Verification And Documentation

**Files:**
- Modify: `docs/social-layer-e2e-test-plan.md`
- Modify: `docs/founder-acceptance-tests.md`

- [ ] **Step 1: Add acceptance coverage**

Add a section to `docs/founder-acceptance-tests.md`:

```md
### Persona social account routing

1. Connect two LinkedIn accounts and two Instagram accounts in one workspace.
2. Create a CEO persona and a Company Page persona.
3. Assign one LinkedIn and one Instagram account as primary for CEO.
4. Assign the other LinkedIn and Instagram accounts as primary for Company Page.
5. Generate and approve a CEO LinkedIn draft.
6. Confirm the publish modal only offers the CEO-assigned LinkedIn account.
7. Create a cadence for the CEO persona with no explicit account override.
8. Confirm the cadence stores and publishes through the CEO primary account.
9. Create a launch for the Company Page persona with LinkedIn and Instagram channels.
10. Confirm dispatch uses the Company Page primary accounts and never the CEO accounts.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- api -t "persona"
npm test -- api -t "publish"
npm test -- api -t "cadence"
npm test -- api -t "launch"
```

Expected: all focused suites pass.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: full Vitest suite passes and TypeScript is clean.

- [ ] **Step 4: Commit docs**

```bash
git add docs/social-layer-e2e-test-plan.md docs/founder-acceptance-tests.md
git commit -m "docs: add persona account routing acceptance tests"
```

---

## Self-Review

Spec coverage:

- Multiple social accounts per provider: Tasks 2 and 3.
- Persona-account many-to-many mapping: Tasks 1, 2, and 4.
- Primary account routing: Tasks 4 and 5.
- Manual publish protection: Task 6.
- Cadence routing: Task 6.
- Launch and X routing: Task 7.
- Web management surfaces: Task 8.
- Acceptance documentation and verification: Task 9.

Completeness scan:

- No unresolved markers.
- No unbounded future-work instructions.
- Every task names files and commands.

Type consistency:

- Contract names match service names: `PersonaSocialAccount`, `UpsertPersonaSocialAccountInput`, `SocialAccountChannel`.
- Route error keys match the design spec.
- Persisted cadence still stores concrete `connectionId`; only create input can omit it when persona routing resolves it.
