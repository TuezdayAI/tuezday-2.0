import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import type { LlmGateway } from "../llm/gateway";
import { runBrainAutoDraft } from "../services/brain-autodraft";

/**
 * Brain auto-draft (Sprint 36.4): onboarding Step 5's "Meet your Brain".
 * Drafts only currently-empty docs from the verified brand profile + social
 * corpus; never clobbers a founder-edited doc. Membership on
 * /workspaces/:id/* is enforced by the auth guard.
 */
export function registerBrainAutoDraftRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  fabric: ConnectorFabric,
): void {
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/brain/auto-draft",
    async (request) => runBrainAutoDraft(db, llm, fabric, request.params.id),
  );
}
