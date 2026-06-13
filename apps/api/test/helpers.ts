import type { InjectOptions } from "fastify";
import { buildApp, type BuildAppOptions, type TuezdayApp } from "../src/app";
import { createDb, type Db } from "../src/db";

/** Fresh in-memory database with all checked-in migrations applied. */
export function createTestDb(): Db {
  return createDb(":memory:");
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
