import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createPostingCadenceInputSchema,
  updatePostingCadenceInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import { buildCalendar } from "../services/calendar";
import { getCampaign } from "../services/campaigns";
import { getConnection, providerByKey } from "../services/connections";
import {
  CADENCE_HORIZON_DAYS,
  createCadence,
  deleteCadence,
  fillActiveCadences,
  fillCadence,
  getCadence,
  getCadenceDetail,
  listCadences,
  updateCadence,
} from "../services/cadences";
import { getPersona } from "../services/personas";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CALENDAR_DAYS = 92;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

/**
 * Validate the campaign / persona / connection a cadence references. Returns an
 * error key (already sent to the client) or null when everything checks out.
 */
function validateRefs(
  db: Db,
  workspaceId: string,
  refs: { campaignId?: string; personaId?: string | null; connectionId?: string },
  reply: FastifyReply,
): boolean {
  if (refs.campaignId !== undefined && !getCampaign(db, workspaceId, refs.campaignId)) {
    void reply.status(400).send({ error: "campaign_not_found" });
    return false;
  }
  if (refs.personaId != null && !getPersona(db, workspaceId, refs.personaId)) {
    void reply.status(400).send({ error: "persona_not_found" });
    return false;
  }
  if (refs.connectionId !== undefined) {
    const connection = getConnection(db, workspaceId, refs.connectionId);
    if (!connection) {
      void reply.status(400).send({ error: "connection_not_found" });
      return false;
    }
    const provider = providerByKey(connection.providerKey);
    if (connection.status !== "connected" || !provider?.categories?.includes("social")) {
      void reply.status(400).send({
        error: "not_social",
        message: "Pick a connected social account for the cadence to post through.",
      });
      return false;
    }
  }
  return true;
}

export function registerCadenceRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/cadences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createPostingCadenceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    if (
      !validateRefs(
        db,
        request.params.id,
        {
          campaignId: parsed.data.campaignId,
          personaId: parsed.data.personaId ?? null,
          connectionId: parsed.data.connectionId,
        },
        reply,
      )
    ) {
      return reply;
    }
    return reply.status(201).send(createCadence(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/cadences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listCadences(db, request.params.id, Date.now());
  });

  app.get<{ Params: { id: string; cadenceId: string } }>(
    "/workspaces/:id/cadences/:cadenceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const cadence = getCadence(db, request.params.id, request.params.cadenceId);
      if (!cadence) return reply.status(404).send({ error: "cadence_not_found" });
      return getCadenceDetail(db, request.params.id, cadence, Date.now());
    },
  );

  app.patch<{ Params: { id: string; cadenceId: string } }>(
    "/workspaces/:id/cadences/:cadenceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const existing = getCadence(db, request.params.id, request.params.cadenceId);
      if (!existing) return reply.status(404).send({ error: "cadence_not_found" });
      const parsed = updatePostingCadenceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      if (!validateRefs(db, request.params.id, parsed.data, reply)) return reply;
      return updateCadence(db, request.params.id, request.params.cadenceId, parsed.data);
    },
  );

  app.delete<{ Params: { id: string; cadenceId: string } }>(
    "/workspaces/:id/cadences/:cadenceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteCadence(db, request.params.id, request.params.cadenceId)) {
        return reply.status(404).send({ error: "cadence_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; cadenceId: string } }>(
    "/workspaces/:id/cadences/:cadenceId/fill",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const cadence = getCadence(db, request.params.id, request.params.cadenceId);
      if (!cadence) return reply.status(404).send({ error: "cadence_not_found" });
      const { filled } = await fillCadence(db, fabric, fetcher, request.params.id, cadence, Date.now());
      const detail = getCadenceDetail(db, request.params.id, cadence, Date.now());
      return { filled, cadence: detail };
    },
  );

  // Worker entry point: fill every active cadence in this workspace.
  app.post<{ Params: { id: string } }>("/workspaces/:id/cadences/run", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const results = await fillActiveCadences(db, fabric, fetcher, request.params.id, Date.now());
    return { results };
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/workspaces/:id/calendar",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const now = Date.now();
      const from = Number(request.query.from) || now;
      let to = Number(request.query.to) || from + CADENCE_HORIZON_DAYS * DAY_MS;
      if (to <= from) to = from + DAY_MS;
      // Bound the window so slot computation stays cheap.
      if (to - from > MAX_CALENDAR_DAYS * DAY_MS) to = from + MAX_CALENDAR_DAYS * DAY_MS;
      return buildCalendar(db, request.params.id, from, to);
    },
  );
}
