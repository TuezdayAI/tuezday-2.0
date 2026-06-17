import type { FastifyInstance, FastifyReply } from "fastify";
import {
  crmSyncFilterInputSchema,
  crmSyncInputSchema,
  logDraftInputSchema,
  pushLeadInputSchema,
  type Connection,
  type ConnectorProvider,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { crmAdapterFor, type CrmAdapter } from "../connectors/crm";
import { ConnectorFabricError, type ConnectorFabric } from "../connectors/fabric";
import { getConnection, providerByKey } from "../services/connections";
import {
  discardCrmContact,
  getCrmContact,
  getCrmContactByLead,
  getCrmSyncFilter,
  importCrmContactAsLead,
  listCrmContacts,
  pushLeadToCrm,
  restoreCrmContact,
  setCrmSyncFilter,
  syncCrmContacts,
} from "../services/crm";
import { getDraft } from "../services/drafts";
import { emitEvent } from "../services/events";
import { getLead } from "../services/leads";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerCrmRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): void {
  /** Resolve a connected, CRM-capable connection to its adapter, or reply with the error. */
  function adapterOrReply(
    workspaceId: string,
    connectionId: string,
    reply: FastifyReply,
  ): { adapter: CrmAdapter; connection: Connection } | undefined {
    const connection = getConnection(db, workspaceId, connectionId);
    if (!connection) {
      void reply.status(404).send({ error: "connection_not_found" });
      return undefined;
    }
    const provider = providerByKey(connection.providerKey);
    if (!provider?.categories?.includes("crm")) {
      void reply.status(400).send({
        error: "not_a_crm_connection",
        message: `${provider?.label ?? connection.providerKey} is not a CRM connection.`,
      });
      return undefined;
    }
    if (connection.status !== "connected") {
      void reply.status(400).send({
        error: "connection_not_connected",
        message: `${provider.label} is ${connection.status}. Reconnect it first.`,
      });
      return undefined;
    }
    const adapter = crmAdapterFor(fabric, provider, connection);
    if (!adapter) {
      void reply.status(400).send({
        error: "no_crm_adapter",
        message: `${provider.label} has no CRM adapter yet.`,
      });
      return undefined;
    }
    return { adapter, connection };
  }

  /** A CRM-capable connection (any status) for filter config — no live adapter. */
  function crmConnectionOrReply(
    workspaceId: string,
    connectionId: string,
    reply: FastifyReply,
  ): { connection: Connection; provider: ConnectorProvider } | undefined {
    const connection = getConnection(db, workspaceId, connectionId);
    if (!connection) {
      void reply.status(404).send({ error: "connection_not_found" });
      return undefined;
    }
    const provider = providerByKey(connection.providerKey);
    if (!provider?.categories?.includes("crm")) {
      void reply.status(400).send({
        error: "not_a_crm_connection",
        message: `${provider?.label ?? connection.providerKey} is not a CRM connection.`,
      });
      return undefined;
    }
    return { connection, provider };
  }

  function crmFailure(reply: FastifyReply, err: unknown) {
    if (err instanceof ConnectorFabricError) {
      return reply.status(502).send({ error: "crm_request_failed", message: err.message });
    }
    throw err;
  }

  app.get<{ Params: { id: string }; Querystring: { discarded?: string } }>(
    "/workspaces/:id/crm/contacts",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listCrmContacts(db, request.params.id, {
        discarded: request.query.discarded === "true",
      });
    },
  );

  app.post<{ Params: { id: string; crmContactId: string } }>(
    "/workspaces/:id/crm/contacts/:crmContactId/discard",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!discardCrmContact(db, request.params.id, request.params.crmContactId)) {
        return reply.status(404).send({ error: "contact_not_found" });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; crmContactId: string } }>(
    "/workspaces/:id/crm/contacts/:crmContactId/restore",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!restoreCrmContact(db, request.params.id, request.params.crmContactId)) {
        return reply.status(404).send({ error: "contact_not_found" });
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { connectionId?: string } }>(
    "/workspaces/:id/crm/views",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!request.query.connectionId) {
        return reply.status(400).send({ error: "invalid_input", message: "connectionId is required." });
      }
      const resolved = adapterOrReply(request.params.id, request.query.connectionId, reply);
      if (!resolved) return reply;
      try {
        return await resolved.adapter.listViews();
      } catch (err) {
        return crmFailure(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { connectionId?: string } }>(
    "/workspaces/:id/crm/sync-filter",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!request.query.connectionId) {
        return reply.status(400).send({ error: "invalid_input", message: "connectionId is required." });
      }
      const resolved = crmConnectionOrReply(request.params.id, request.query.connectionId, reply);
      if (!resolved) return reply;
      return getCrmSyncFilter(db, resolved.connection.id);
    },
  );

  app.put<{ Params: { id: string } }>("/workspaces/:id/crm/sync-filter", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = crmSyncFilterInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const resolved = crmConnectionOrReply(request.params.id, parsed.data.connectionId, reply);
    if (!resolved) return reply;
    return setCrmSyncFilter(db, request.params.id, resolved.connection.id, parsed.data.filter);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/crm/sync", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = crmSyncInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const resolved = adapterOrReply(request.params.id, parsed.data.connectionId, reply);
    if (!resolved) return reply;
    const filter = getCrmSyncFilter(db, resolved.connection.id);
    try {
      return await syncCrmContacts(
        db,
        resolved.adapter,
        request.params.id,
        resolved.connection.id,
        filter,
      );
    } catch (err) {
      return crmFailure(reply, err);
    }
  });

  app.post<{ Params: { id: string; crmContactId: string } }>(
    "/workspaces/:id/crm/contacts/:crmContactId/import-lead",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const contact = getCrmContact(db, request.params.id, request.params.crmContactId);
      if (!contact) return reply.status(404).send({ error: "contact_not_found" });
      const connection = getConnection(db, request.params.id, contact.connectionId);
      const provider = connection ? providerByKey(connection.providerKey) : undefined;
      const result = importCrmContactAsLead(
        db,
        request.params.id,
        contact,
        provider?.label ?? "the CRM",
      );
      if (!result.ok) {
        const status = result.error === "already_linked" ? 409 : 400;
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(201).send({ lead: result.lead, linkedExisting: result.linkedExisting });
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/crm/push-lead", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = pushLeadInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const resolved = adapterOrReply(request.params.id, parsed.data.connectionId, reply);
    if (!resolved) return reply;
    const lead = getLead(db, request.params.id, parsed.data.leadId);
    if (!lead) return reply.status(404).send({ error: "lead_not_found" });
    if (getCrmContactByLead(db, request.params.id, lead.id, resolved.connection.id)) {
      return reply.status(409).send({
        error: "already_linked",
        message: `${lead.name} is already linked to a contact on this connection.`,
      });
    }
    try {
      const contact = await pushLeadToCrm(
        db,
        resolved.adapter,
        request.params.id,
        resolved.connection.id,
        lead,
      );
      await emitEvent(db, fetcher, request.params.id, "crm.contact.created", {
        crmContactId: contact.id,
        externalId: contact.externalId,
        leadId: lead.id,
        provider: resolved.connection.providerKey,
      });
      return reply.status(201).send(contact);
    } catch (err) {
      return crmFailure(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/crm/log-draft", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = logDraftInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const draft = getDraft(db, request.params.id, parsed.data.draftId);
    if (!draft) return reply.status(404).send({ error: "draft_not_found" });
    if (draft.state !== "approved") {
      return reply.status(400).send({
        error: "draft_not_approved",
        message: "Only approved drafts can be logged to the CRM.",
      });
    }
    if (!draft.leadId) {
      return reply.status(400).send({
        error: "draft_has_no_lead",
        message: "This draft is not tied to a lead.",
      });
    }
    const contact = getCrmContactByLead(db, request.params.id, draft.leadId);
    if (!contact) {
      return reply.status(400).send({
        error: "lead_not_linked",
        message: "This lead is not linked to a CRM contact yet — push the lead first.",
      });
    }
    const resolved = adapterOrReply(request.params.id, contact.connectionId, reply);
    if (!resolved) return reply;
    try {
      await resolved.adapter.createNote(
        contact.externalId,
        `${draft.content}\n\n— Approved in Tuezday (draft ${draft.id})`,
      );
      await emitEvent(db, fetcher, request.params.id, "crm.note.logged", {
        draftId: draft.id,
        leadId: draft.leadId,
        crmContactId: contact.id,
        externalId: contact.externalId,
        provider: resolved.connection.providerKey,
      });
      return { ok: true, externalId: contact.externalId };
    } catch (err) {
      return crmFailure(reply, err);
    }
  });
}
