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

/** drafts/brain services take this slice of the actor for attribution. */
export function actorOf(request: FastifyRequest): { userId: string | null; label: string } {
  return { userId: request.actor.userId, label: request.actor.label };
}

const PUBLIC_ROUTES = new Set([
  "POST /auth/register",
  "POST /auth/login",
  "GET /health",
  "POST /webhooks/stripe",
]);
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
    if (PUBLIC_ROUTES.has(`${request.method} ${route}`)) return;

    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.status(401).send({ error: "unauthenticated" });

    if (workerToken && token === workerToken) {
      request.actor = { userId: null, label: "system", email: null, system: true };
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
