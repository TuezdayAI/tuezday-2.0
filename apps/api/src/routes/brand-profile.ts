import type { FastifyInstance } from "fastify";
import { updateBrandProfileInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import type { Fetcher } from "../discovery/adapters";
import type { LlmGateway } from "../llm/gateway";
import {
  getBrandProfileView,
  runBrandProfile,
  updateBrandProfile,
} from "../services/brand-profile";
import { getWorkspace } from "../services/workspaces";

/**
 * Brand profile (Sprint 36.2): what onboarding extracted from the website.
 * Workspace membership is already enforced by the auth guard on
 * /workspaces/:id/* — unknown workspace ids 404 there.
 */
export function registerBrandProfileRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  fetcher: Fetcher,
): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/brand-profile",
    async (request) => getBrandProfileView(db, request.params.id),
  );

  // Inline, awaited re-run (deterministic for callers and tests); workspace
  // creation fire-and-forgets the same runBrandProfile.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/brand-profile/refresh",
    async (request, reply) => {
      const workspace = getWorkspace(db, request.params.id);
      if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });
      if (!workspace.websiteUrl) {
        return reply.status(400).send({
          error: "no_website_url",
          message: "This workspace has no website URL to read.",
        });
      }
      return runBrandProfile(db, llm, fetcher, workspace.id, workspace.websiteUrl);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id/brand-profile",
    async (request, reply) => {
      const parsed = updateBrandProfileInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = updateBrandProfile(db, request.params.id, parsed.data);
      if (!result.ok) {
        return reply.status(409).send({
          error: "profile_not_ready",
          message: "The brand profile is not ready to edit yet.",
        });
      }
      return result.view;
    },
  );
}
