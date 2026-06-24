import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createInviteInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { appBaseUrl, type Mailer } from "../mail/mailer";
import { getUser } from "../services/auth";
import {
  acceptInvite,
  AlreadyInvitedError,
  AlreadyMemberError,
  createInvite,
  getInviteByToken,
  listMembers,
  listPendingInvites,
  removeMember,
  revokeInvite,
} from "../services/teams";
import { getWorkspace } from "../services/workspaces";

/** Team management is owner-only; the worker's system actor also passes. */
function ownerOr403(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.actor.system || request.actor.role === "owner") return true;
  void reply.status(403).send({ error: "owner_only" });
  return false;
}

export function registerTeamRoutes(app: FastifyInstance, db: Db, mailer: Mailer): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/members", async (request) =>
    listMembers(db, request.params.id),
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/workspaces/:id/members/:userId",
    async (request, reply) => {
      if (!ownerOr403(request, reply)) return reply;
      const result = removeMember(db, request.params.id, request.params.userId);
      if (result === "not_found") return reply.status(404).send({ error: "member_not_found" });
      if (result === "last_owner") {
        return reply.status(409).send({
          error: "last_owner",
          message: "A workspace must keep at least one owner.",
        });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/invites", async (request, reply) => {
    if (!ownerOr403(request, reply)) return reply;
    const parsed = createInviteInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    try {
      const invite = createInvite(
        db,
        request.params.id,
        parsed.data.email,
        // The worker never creates invites in practice; attribute to the
        // acting user when there is one.
        request.actor.userId ?? "system",
      );
      // Email the invite link. Best-effort: a mailer failure must never fail
      // invite creation — the response still carries the token for manual share.
      const workspace = getWorkspace(db, request.params.id);
      const link = `${appBaseUrl()}/invites/${invite.token}`;
      void mailer
        .send({
          to: invite.email,
          subject: `You're invited to ${workspace?.name ?? "a workspace"} on Tuezday`,
          text: `You've been invited to join ${workspace?.name ?? "a workspace"} on Tuezday.\n\nAccept your invite: ${link}\n\nIf you didn't expect this, you can ignore this email.`,
          html: `<p>You've been invited to join <strong>${workspace?.name ?? "a workspace"}</strong> on Tuezday.</p><p><a href="${link}">Accept your invite</a></p><p>If you didn't expect this, you can ignore this email.</p>`,
        })
        .catch((err) => {
          app.log.error(`invite email failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return reply.status(201).send(invite);
    } catch (err) {
      if (err instanceof AlreadyMemberError) {
        return reply.status(409).send({ error: "already_member", message: err.message });
      }
      if (err instanceof AlreadyInvitedError) {
        return reply.status(409).send({ error: "already_invited", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/invites", async (request, reply) => {
    if (!ownerOr403(request, reply)) return reply;
    return listPendingInvites(db, request.params.id);
  });

  app.delete<{ Params: { id: string; inviteId: string } }>(
    "/workspaces/:id/invites/:inviteId",
    async (request, reply) => {
      if (!ownerOr403(request, reply)) return reply;
      if (!revokeInvite(db, request.params.id, request.params.inviteId)) {
        return reply.status(404).send({ error: "invite_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { token: string } }>("/invites/:token", async (request, reply) => {
    const invite = getInviteByToken(db, request.params.token);
    if (!invite) return reply.status(404).send({ error: "invite_not_found" });
    const workspace = getWorkspace(db, invite.workspaceId);
    return {
      workspaceName: workspace?.name ?? "",
      email: invite.email,
      status: invite.expiresAt <= Date.now() && invite.status === "pending" ? "expired" : invite.status,
      expiresAt: invite.expiresAt,
    };
  });

  app.post<{ Params: { token: string } }>("/invites/:token/accept", async (request, reply) => {
    if (request.actor.system || !request.actor.userId) {
      return reply.status(403).send({ error: "system_actor" });
    }
    const user = getUser(db, request.actor.userId);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    const result = acceptInvite(db, request.params.token, user);
    if (!result.ok) {
      if (result.error === "not_found") {
        return reply.status(404).send({ error: "invite_not_found" });
      }
      if (result.error === "email_mismatch") {
        return reply.status(403).send({
          error: "email_mismatch",
          message: "This invite was issued for a different email address.",
        });
      }
      return reply.status(410).send({
        error: "invite_gone",
        message: "This invite has expired or was revoked.",
      });
    }
    const workspace = getWorkspace(db, result.workspaceId);
    return {
      workspaceId: result.workspaceId,
      workspaceName: workspace?.name ?? "",
      role: result.role,
    };
  });
}
