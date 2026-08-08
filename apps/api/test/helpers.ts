import type { InjectOptions } from "fastify";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionKind,
  type ExternalActionPolicyRule,
  type ExternalActionPolicyScope,
} from "@tuezday/contracts";
import type pg from "pg";
import { buildApp, type BuildAppOptions, type TuezdayApp } from "../src/app";
import { closeDb, createDb, type Db } from "../src/db";
import {
  adminClient,
  cloneTemplate,
  fixtureDatabaseName,
  quoteIdent,
  urlFor,
} from "./postgres";

/**
 * One maintenance connection per worker, opened on first use. Fixtures are
 * created constantly, and a fresh connect() per fixture would cost more than
 * the CREATE DATABASE it issues.
 */
let admin: Promise<pg.Client> | undefined;

/** Every fixture this worker opened, so the setup file can drop them per test file. */
const fixtures: { name: string; url: string; db: Db }[] = [];

/**
 * Fresh Postgres database with all checked-in migrations applied.
 *
 * Cloned from the template the global setup built, so this costs a directory
 * copy rather than replaying the baseline. The pool is small and drops idle
 * connections quickly: a full run opens hundreds of fixtures, and the server's
 * connection limit is the binding constraint, not throughput.
 */
export async function createTestDb(): Promise<Db> {
  const name = fixtureDatabaseName();
  admin ??= adminClient();
  await cloneTemplate(await admin, name);
  const url = urlFor(name);
  // Small pool with a short idle timeout: a run opens hundreds of fixtures and
  // holds each until its file ends, so the binding constraint is the server's
  // connection slots rather than per-fixture throughput.
  const db = await createDb(url, {
    migrated: true,
    max: 2,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
  fixtures.push({ name, url, db });
  return db;
}

/**
 * A second, independent pool onto an existing fixture: the Postgres equivalent
 * of two API processes opening the same database file. Restart and
 * two-instance-contention tests need genuinely separate connections, not a
 * second handle on the same one.
 */
export async function connectTestDbAgain(db: Db): Promise<Db> {
  const fixture = fixtures.find((f) => f.db === db);
  if (!fixture) throw new Error("connectTestDbAgain: not a fixture from createTestDb()");
  const second = await createDb(fixture.url, { migrated: true, max: 4 });
  // Same name: the drop below is IF EXISTS, so the repeat is a no-op.
  fixtures.push({ name: fixture.name, url: fixture.url, db: second });
  return second;
}

/**
 * Close and drop every fixture this worker opened. Called from the setup file's
 * afterAll, which runs once per test file.
 */
export async function dropTestDbs(): Promise<void> {
  const taken = fixtures.splice(0, fixtures.length);
  if (taken.length === 0) return;
  await Promise.all(taken.map(({ db }) => closeDb(db)));
  const client = await (admin ??= adminClient());
  for (const { name } of taken) {
    // FORCE: a test that leaked a connection should not wedge the whole run.
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  }
}

/** Close this worker's maintenance connection. */
export async function closeTestAdmin(): Promise<void> {
  if (!admin) return;
  const client = await admin;
  admin = undefined;
  await client.end().catch(() => {});
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
