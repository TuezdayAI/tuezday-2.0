import type { FastifyInstance } from "fastify";
import {
  createWorkspaceInputSchema,
  ONBOARDING_CURSORS,
  setAnalyticsOptOutInputSchema,
  type OnboardingCursor,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  advanceOnboarding,
  createWorkspace,
  getAnalyticsOptOut,
  getWorkspace,
  listWorkspaces,
  listWorkspacesForUser,
  setAnalyticsOptOut,
} from "../services/workspaces";
import { listConnections } from "../services/connections";
import { listAdAccounts } from "../services/ads";
import { listDrafts } from "../services/drafts";
import { listGenerations } from "../services/generations";

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  app.post("/workspaces", async (request, reply) => {
    const parsed = createWorkspaceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const workspace = createWorkspace(db, parsed.data, request.actor.userId);
    return reply.status(201).send(workspace);
  });

  app.get("/workspaces", async (request) =>
    // The worker's system actor polls every workspace; users see their own.
    request.actor.system ? listWorkspaces(db) : listWorkspacesForUser(db, request.actor.userId!),
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return workspace;
  });
  app.patch<{ Params: { id: string }; Body: { step?: string } }>(
    "/workspaces/:id/onboarding",
    async (request, reply) => {
      const step = request.body?.step;
      if (!step || !ONBOARDING_CURSORS.includes(step as OnboardingCursor)) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `step must be one of: ${ONBOARDING_CURSORS.join(", ")}`,
        });
      }
      const updated = advanceOnboarding(db, request.params.id, step as OnboardingCursor);
      if (!updated) return reply.status(404).send({ error: "workspace_not_found" });
      return updated;
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/analytics-optout", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });
    return { optOut: getAnalyticsOptOut(db, request.params.id) };
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/analytics-optout", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });
    const parsed = setAnalyticsOptOutInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    setAnalyticsOptOut(db, request.params.id, parsed.data.optOut);
    return { optOut: parsed.data.optOut };
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/capabilities", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });
    
    const connections = listConnections(db, request.params.id);
    const adAccounts = listAdAccounts(db, request.params.id);
    const drafts = listDrafts(db, request.params.id, "pending_review");
    const generations = listGenerations(db, request.params.id);
    
    return {
      hasAds: adAccounts.length > 0,
      hasInsights: false, // reserved for Sprint 34
      hasCrm: connections.some(c => c.providerKey === "salesforce" || c.providerKey === "hubspot" || c.providerKey === "freshsales"),
      hasConnections: connections.length > 0,
      draftCount: drafts.length,
      generationCount: generations.length
    };
  });
}
