import type { FastifyInstance, FastifyReply } from "fastify";
import {
  PACKAGE_STATUSES,
  packageDecisionInputSchema,
  type PackageStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { actorOf } from "../auth/guard";
import type { LlmGateway } from "../llm/gateway";
import {
  InvalidPackageTransitionError,
  PackageNotFoundError,
  createPackageFromOpportunity,
  decidePackage,
  getPackageDetail,
  listPackages,
} from "../services/content-packages";
import {
  InvalidOpportunityTransitionError,
  OpportunityNotFoundError,
} from "../services/opportunities";
import { runPackageAssessments, runPackagePipeline } from "../services/sufficiency";
import { DEFAULT_DISCOVERY_POLICY } from "../runtime/operator-policy";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

// Sprint 62: content packages, sufficiency & lane eligibility — the
// source-grounded narrative unit between opportunity and deliverable
// (design §8.7–§8.9).
export function registerPackageRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
): void {
  app.get<{
    Params: { id: string };
    Querystring: {
      status?: string;
      campaignId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/workspaces/:id/packages", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const { status, campaignId, limit, offset } = request.query;
    if (
      status !== undefined &&
      !PACKAGE_STATUSES.includes(status as PackageStatus)
    ) {
      return reply.status(400).send({ error: "invalid_input", message: "unknown status" });
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
        message: "limit must be a positive integer and offset a non-negative integer",
      });
    }
    return listPackages(db, request.params.id, {
      status: status as PackageStatus | undefined,
      campaignId,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  app.get<{ Params: { id: string; packageId: string } }>(
    "/workspaces/:id/packages/:packageId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return getPackageDetail(db, request.params.id, request.params.packageId);
      } catch (err) {
        if (err instanceof PackageNotFoundError) {
          return reply.status(404).send({ error: "package_not_found" });
        }
        throw err;
      }
    },
  );

  // Operator create (D-62.1/2): consume a qualified opportunity into a
  // package. The opportunity transitions to package_created in the same txn.
  app.post<{ Params: { id: string; opportunityId: string } }>(
    "/workspaces/:id/opportunities/:opportunityId/package",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        const packageId = createPackageFromOpportunity(
          db,
          request.params.id,
          request.params.opportunityId,
          { userId: actorOf(request).userId },
        );
        return reply
          .status(201)
          .send(getPackageDetail(db, request.params.id, packageId));
      } catch (err) {
        if (err instanceof OpportunityNotFoundError) {
          return reply.status(404).send({ error: "opportunity_not_found" });
        }
        if (err instanceof InvalidOpportunityTransitionError) {
          return reply.status(400).send({
            error: "invalid_transition",
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; packageId: string } }>(
    "/workspaces/:id/packages/:packageId/decision",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = packageDecisionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return decidePackage(db, request.params.id, request.params.packageId, {
          action: parsed.data.action,
          reason: parsed.data.reason,
          actorUserId: actorOf(request).userId,
        });
      } catch (err) {
        if (err instanceof PackageNotFoundError) {
          return reply.status(404).send({ error: "package_not_found" });
        }
        if (err instanceof InvalidPackageTransitionError) {
          return reply.status(400).send({
            error: "invalid_transition",
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  // Synchronous single-package assessment (D-60.5 precedent). Runs only when
  // the package is due (pending / lease-expired); 409 otherwise.
  app.post<{ Params: { id: string; packageId: string } }>(
    "/workspaces/:id/packages/:packageId/assess",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        getPackageDetail(db, request.params.id, request.params.packageId);
      } catch (err) {
        if (err instanceof PackageNotFoundError) {
          return reply.status(404).send({ error: "package_not_found" });
        }
        throw err;
      }
      const assessed = await runPackageAssessments(db, llm, {
        workspaceId: request.params.id,
        limit: 1,
        leaseMs: DEFAULT_DISCOVERY_POLICY.leaseMs,
        timeoutMs: DEFAULT_DISCOVERY_POLICY.packageTimeoutMs,
        packageId: request.params.packageId,
      });
      if (assessed.claimed === 0) {
        return reply.status(409).send({ error: "not_due" });
      }
      return getPackageDetail(db, request.params.id, request.params.packageId);
    },
  );

  // Founder-triggered synchronous pipeline run: auto-package + assess,
  // bounded by the tick default, demonstrable without the worker.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/packages/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return runPackagePipeline(db, llm, {
        workspaceId: request.params.id,
        limit: DEFAULT_DISCOVERY_POLICY.maxPackagesPerTick,
        leaseMs: DEFAULT_DISCOVERY_POLICY.leaseMs,
        timeoutMs: DEFAULT_DISCOVERY_POLICY.packageTimeoutMs,
      });
    },
  );
}
