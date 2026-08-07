import type { InjectOptions } from "fastify";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionKind,
  type ExternalActionPolicyRule,
  type ExternalActionPolicyScope,
} from "@tuezday/contracts";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { buildApp, type BuildAppOptions, type TuezdayApp } from "../src/app";
import { migrationsFolder, schema, type Db } from "../src/db";

/**
 * A schema template built by running the real checked-in migrations once per
 * worker process. Restoring a database from it costs a memory copy instead of
 * ~80 migration statements, which is the difference between a test fixture
 * that takes ~700ms and one that takes ~15ms. The migrations are still
 * executed on every run — just once rather than once per test.
 */
let schemaTemplate: Buffer | undefined;

function buildSchemaTemplate(): Buffer {
  const seed = new Database(":memory:");
  seed.pragma("foreign_keys = ON");
  migrate(drizzle(seed, { schema }), { migrationsFolder });
  const snapshot = seed.serialize();
  seed.close();
  return snapshot;
}

/** Fresh in-memory database with all checked-in migrations applied. */
export function createTestDb(): Db {
  schemaTemplate ??= buildSchemaTemplate();
  const sqlite = new Database(schemaTemplate);
  // A connection pragma, not part of the serialized file — set it every time.
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  token: string;
}

export const TEST_PASSWORD = "test-password-1";

/** Register a user through the real /auth/register route and return their bearer token. */
export async function registerUser(
  app: TuezdayApp,
  email = "founder@test.dev",
  name = "founder",
): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: TEST_PASSWORD, name },
  });
  if (res.statusCode !== 201) {
    throw new Error(`test registerUser failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  return { id: body.user.id, email: body.user.email, name: body.user.name, token: body.token };
}

/** A view of the app whose inject() always carries the user's bearer token. */
export function asUser(app: TuezdayApp, token: string): TuezdayApp {
  return new Proxy(app, {
    get(target, prop) {
      if (prop === "inject") {
        return (opts: InjectOptions) =>
          target.inject({
            ...opts,
            headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Build the app with a registered default user ("founder") already signed in;
 * every inject() carries their bearer token. Existing suites use this so the
 * auth layer stays real (no bypass flag) without per-test ceremony.
 */
export async function buildAuthedApp(options: BuildAppOptions): Promise<TuezdayApp> {
  const app = await buildApp(options);
  const user = await registerUser(app);
  return asUser(app, user.token);
}

/** Write one complete optimistic action-policy scope through the public API. */
export async function putActionPolicy(
  app: TuezdayApp,
  workspaceId: string,
  scope: ExternalActionPolicyScope,
  scopeId: string,
  overrides: Partial<Record<ExternalActionKind, ExternalActionPolicyRule>>,
) {
  const current = await app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/external-action-policies?scope=${scope}&scopeId=${scopeId}`,
  });
  if (current.statusCode !== 200) return current;
  const expectedUpdatedAt = (current.json() as { updatedAt: number | null }).updatedAt;
  const fallback: ExternalActionPolicyRule = scope === "workspace" ? "human_required" : "inherit";
  return await app.inject({
    method: "PUT",
    url: `/workspaces/${workspaceId}/external-action-policies`,
    payload: {
      scope,
      scopeId,
      expectedUpdatedAt,
      rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({
        actionKind,
        rule: overrides[actionKind] ?? fallback,
      })),
    },
  });
}
