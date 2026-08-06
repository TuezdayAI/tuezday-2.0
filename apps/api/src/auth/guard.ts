import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkspaceRole } from "@tuezday/contracts";
import type { Db } from "../db";
import { sessionUser } from "../services/auth";
import { claimIfMemberless, membershipRole } from "../services/teams";
import { getWorkspace } from "../services/workspaces";

/** Who is making this request — a signed-in user or the worker's system token. */
export interface Actor {
  /** Null for the system actor. */
  userId: string | null;
  /** Display label for decision logs / version history: name, email, or "system". */
  label: string;
  email: string | null;
  system: boolean;
  /** Role in the workspace targeted by the route, when applicable. */
  role?: WorkspaceRole;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

/**
 * drafts/brain services take this slice of the actor for attribution.
 *
 * `human` (Sprint 52) fails closed: it is established affirmatively by a
 * signed-in user identity, never inferred from "not the worker". A future
 * guard actor that is neither the worker nor a person — a service token, a
 * delegated integration identity — therefore arrives as non-human and cannot
 * collapse the publish gate by accident; humanity would have to be plumbed
 * through deliberately. This changes nothing today: the guard sets exactly two
 * actors, the system actor (null `userId`) and a session user (non-null), so
 * this agrees with the previous `!system` derivation on both.
 *
 * Delegated-human paths (the signed email/Telegram approve links) and the
 * public-API machine credential bypass the auth guard entirely and declare
 * `human` themselves at their own call sites.
 */
export function actorOf(
  request: FastifyRequest,
): { userId: string | null; label: string; human: boolean } {
  const { userId, label, system } = request.actor;
  return { userId, label, human: userId !== null && !system };
}

const PUBLIC_ROUTES = new Set([
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/google/url",
  "POST /auth/google/callback",
  "GET /health",
  "POST /webhooks/stripe",
  "POST /webhooks/resend",
  "GET /a/:token",
  "GET /u/:token",
  "POST /u/:token",
  "GET /t/o/:token",
  "GET /t/c/:token",
  "POST /telegram/webhook",
]);

const WORKER_ROUTE_ALLOWLIST = new Set([
  "GET /workspaces",
  "GET /workspaces/:id/learning/syntheses",
  "POST /workspaces/:id/learning/synthesize",
  "POST /workspaces/:id/ads/sync",
  "POST /workspaces/:id/publish/run",
  "POST /workspaces/:id/external-actions/run",
  "POST /workspaces/:id/cadences/run",
  "POST /workspaces/:id/inbox/run",
  "POST /workspaces/:id/mailbox-inbox/run",
  "POST /workspaces/:id/outreach/run",
  "POST /workspaces/:id/sequences/run",
  "POST /workspaces/:id/evidence/candidates/sweep",
]);

export function secureWorkerTokenEqual(
  supplied: string,
  expected: string,
): boolean {
  const suppliedDigest = createHash("sha256")
    .update(supplied, "utf8")
    .digest();
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/**
 * Global auth: every route outside PUBLIC_ROUTES needs a valid session (or the
 * worker token), and every /workspaces/:id/... route needs membership in that
 * workspace. Must be registered before any routes.
 */
export function registerAuthGuard(app: FastifyInstance, db: Db, workerToken?: string): void {
  app.decorateRequest("actor");

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const route = request.routeOptions.url ?? request.url;
    if (route.startsWith("/api/v1/")) return;
    if (
      (request.method === "GET" || request.method === "POST") &&
      request.url.startsWith("/u/")
    ) {
      return;
    }
    if (PUBLIC_ROUTES.has(`${request.method} ${route}`)) return;

    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.status(401).send({ error: "unauthenticated" });
    const workerAuthenticated = Boolean(
      workerToken && secureWorkerTokenEqual(token, workerToken),
    );

    if (route.startsWith("/internal/")) {
      if (!workerAuthenticated) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      request.actor = { userId: null, label: "system", email: null, system: true };
      return;
    }

    if (workerAuthenticated) {
      if (!WORKER_ROUTE_ALLOWLIST.has(`${request.method} ${route}`)) {
        return reply.status(403).send({ error: "forbidden" });
      }
      request.actor = {
        userId: null,
        label: "system",
        email: null,
        system: true,
      };
    } else {
      const user = sessionUser(db, token);
      if (!user) return reply.status(401).send({ error: "unauthenticated" });
      request.actor = {
        userId: user.id,
        label: user.name || user.email,
        email: user.email,
        system: false,
      };
    }

    const params = request.params as { id?: string };
    if (route.startsWith("/workspaces/:id") && params.id) {
      if (request.actor.system) return;
      if (!getWorkspace(db, params.id)) {
        return reply.status(404).send({ error: "workspace_not_found" });
      }
      const userId = request.actor.userId!;
      let role = membershipRole(db, params.id, userId);
      if (!role && claimIfMemberless(db, params.id, userId)) role = "owner";
      if (!role) return reply.status(403).send({ error: "not_a_member" });
      request.actor.role = role;
    }
  });
}
