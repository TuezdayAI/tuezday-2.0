import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import { readSocialCorpus } from "../services/social-corpus";

/**
 * Social corpus (Sprint 36.3): what onboarding Step 3 read from the connected
 * social accounts. Read live on demand — nothing persisted. Membership on
 * /workspaces/:id/* is enforced by the auth guard.
 */
export function registerSocialCorpusRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/social-corpus",
    async (request) => readSocialCorpus(db, fabric, request.params.id),
  );
}
