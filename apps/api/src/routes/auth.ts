import type { FastifyInstance } from "fastify";
import { loginInputSchema, registerInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { EmailTakenError, getUser, login, registerAccount, revokeSession } from "../services/auth";
import { listUserMemberships } from "../services/teams";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";

export function registerAuthRoutes(app: FastifyInstance, db: Db, analytics: AnalyticsSink): void {
  app.post("/auth/register", async (request, reply) => {
    const parsed = registerInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    try {
      const result = registerAccount(db, parsed.data);
      track(db, analytics, { event: "user.registered", distinctId: result.user.id });
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof EmailTakenError) {
        return reply.status(409).send({ error: "email_taken", message: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input" });
    }
    const result = login(db, parsed.data);
    if (!result) {
      return reply.status(401).send({ error: "invalid_credentials" });
    }
    return result;
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.headers.authorization?.split(" ")[1];
    if (token) revokeSession(db, token);
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    if (request.actor.system || !request.actor.userId) {
      return reply.status(403).send({ error: "system_actor" });
    }
    const user = getUser(db, request.actor.userId);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    return { user, memberships: listUserMemberships(db, user.id) };
  });
}
