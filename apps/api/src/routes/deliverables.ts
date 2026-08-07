import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DELIVERABLE_PRODUCTION_STATUSES,
  deliverableDecisionInputSchema,
  type DeliverableProductionStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { actorOf } from "../auth/guard";
import type { LlmGateway } from "../llm/gateway";
import {
  DeliverableNotFoundError,
  InvalidDeliverableTransitionError,
  InvalidPackageStateError,
  SnapshotNotFoundError,
  VariantNotFoundError,
  decideDeliverable,
  fanOutPackage,
  getDeliverableDetail,
  getVariantSnapshot,
  listDeliverables,
} from "../services/deliverables";
import { PackageNotFoundError } from "../services/content-packages";
import {
  runDeliverablePipeline,
  runVariantGeneration,
} from "../services/variant-generation";
import { DEFAULT_DISCOVERY_POLICY } from "../runtime/operator-policy";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

// Sprint 63: deliverables, variants & context snapshots — one campaign
// commitment per lane and time, with replayable candidate executions
// (design §8.10, §9.5).
export function registerDeliverableRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
): void {
  app.get<{
    Params: { id: string };
    Querystring: {
      status?: string;
      campaignId?: string;
      laneId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/workspaces/:id/deliverables", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const { status, campaignId, laneId, limit, offset } = request.query;
    if (
      status !== undefined &&
      !DELIVERABLE_PRODUCTION_STATUSES.includes(
        status as DeliverableProductionStatus,
      )
    ) {
      return reply
        .status(400)
        .send({ error: "invalid_input", message: "unknown status" });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const parsedOffset = offset === undefined ? undefined : Number(offset);
    if (
      (parsedLimit !== undefined &&
        (!Number.isInteger(parsedLimit) || parsedLimit < 1)) ||
      (parsedOffset !== undefined &&
        (!Number.isInteger(parsedOffset) || parsedOffset < 0))
    ) {
      return reply.status(400).send({
        error: "invalid_input",
        message:
          "limit must be a positive integer and offset a non-negative integer",
      });
    }
    return await listDeliverables(db, request.params.id, {
      status: status as DeliverableProductionStatus | undefined,
      campaignId,
      laneId,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  app.get<{ Params: { id: string; deliverableId: string } }>(
    "/workspaces/:id/deliverables/:deliverableId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await getDeliverableDetail(
          db,
          request.params.id,
          request.params.deliverableId,
        );
      } catch (err) {
        if (err instanceof DeliverableNotFoundError) {
          return reply.status(404).send({ error: "deliverable_not_found" });
        }
        throw err;
      }
    },
  );

  // The replay/audit view: everything the model saw for one variant.
  app.get<{ Params: { id: string; deliverableId: string; variantId: string } }>(
    "/workspaces/:id/deliverables/:deliverableId/variants/:variantId/snapshot",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await getVariantSnapshot(
          db,
          request.params.id,
          request.params.deliverableId,
          request.params.variantId,
        );
      } catch (err) {
        if (err instanceof VariantNotFoundError) {
          return reply.status(404).send({ error: "variant_not_found" });
        }
        if (err instanceof SnapshotNotFoundError) {
          return reply.status(404).send({ error: "snapshot_not_found" });
        }
        throw err;
      }
    },
  );

  // Operator fan-out (§9.5, D-63.3/4): re-runnable while the package is ready.
  app.post<{ Params: { id: string; packageId: string } }>(
    "/workspaces/:id/packages/:packageId/fan-out",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await fanOutPackage(db, request.params.id, request.params.packageId, {
          userId: actorOf(request).userId,
        });
      } catch (err) {
        if (err instanceof PackageNotFoundError) {
          return reply.status(404).send({ error: "package_not_found" });
        }
        if (err instanceof InvalidPackageStateError) {
          return reply
            .status(400)
            .send({ error: "invalid_state", message: err.message });
        }
        throw err;
      }
    },
  );

  // Synchronous single-deliverable generation (D-60.5 precedent). Runs only
  // when the deliverable is due (pending / lease-expired); 409 otherwise.
  app.post<{ Params: { id: string; deliverableId: string } }>(
    "/workspaces/:id/deliverables/:deliverableId/generate",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        await getDeliverableDetail(db, request.params.id, request.params.deliverableId);
      } catch (err) {
        if (err instanceof DeliverableNotFoundError) {
          return reply.status(404).send({ error: "deliverable_not_found" });
        }
        throw err;
      }
      const generated = await runVariantGeneration(db, llm, {
        workspaceId: request.params.id,
        limit: 1,
        leaseMs: DEFAULT_DISCOVERY_POLICY.leaseMs,
        timeoutMs: DEFAULT_DISCOVERY_POLICY.variantTimeoutMs,
        deliverableId: request.params.deliverableId,
        actorUserId: actorOf(request).userId,
      });
      if (generated.claimed === 0) {
        return reply.status(409).send({ error: "not_due" });
      }
      return await getDeliverableDetail(
        db,
        request.params.id,
        request.params.deliverableId,
      );
    },
  );

  app.post<{ Params: { id: string; deliverableId: string } }>(
    "/workspaces/:id/deliverables/:deliverableId/decision",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = deliverableDecisionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await decideDeliverable(
          db,
          request.params.id,
          request.params.deliverableId,
          {
            action: parsed.data.action,
            variantId: parsed.data.variantId,
            reason: parsed.data.reason,
            actorUserId: actorOf(request).userId,
          },
        );
      } catch (err) {
        if (err instanceof DeliverableNotFoundError) {
          return reply.status(404).send({ error: "deliverable_not_found" });
        }
        if (err instanceof VariantNotFoundError) {
          return reply.status(404).send({ error: "variant_not_found" });
        }
        if (err instanceof InvalidDeliverableTransitionError) {
          return reply
            .status(400)
            .send({ error: "invalid_transition", message: err.message });
        }
        throw err;
      }
    },
  );

  // Founder-triggered synchronous pipeline run: materialize + fan out +
  // generate + sweep, bounded by the tick default, demonstrable without the
  // worker.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/deliverables/run",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await runDeliverablePipeline(db, llm, {
        workspaceId: request.params.id,
        limit: DEFAULT_DISCOVERY_POLICY.maxDeliverablesPerTick,
        leaseMs: DEFAULT_DISCOVERY_POLICY.leaseMs,
        timeoutMs: DEFAULT_DISCOVERY_POLICY.variantTimeoutMs,
      });
    },
  );
}
