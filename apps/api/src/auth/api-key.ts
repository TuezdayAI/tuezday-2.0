import type { FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "../db";
import type { ApiScope } from "@tuezday/contracts";
import { verifyApiKey } from "../services/api-keys";

export interface ApiActor {
  workspaceId: string;
  scopes: ApiScope[];
}

declare module "fastify" {
  interface FastifyRequest {
    apiActor?: ApiActor;
  }
}

export function apiKeyAuth(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401).send({ error: "unauthorized" });
      return;
    }

    const token = authHeader.substring(7);
    const actor = verifyApiKey(db, token);

    if (!actor) {
      reply.status(401).send({ error: "unauthorized" });
      return;
    }

    request.apiActor = actor;
  };
}

export function requireScope(scope: ApiScope) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.apiActor;
    if (!actor) {
      reply.status(401).send({ error: "unauthorized" });
      return;
    }

    if (!actor.scopes.includes(scope)) {
      reply.status(403).send({ error: "insufficient_scope" });
      return;
    }
  };
}
