import type { FastifyInstance, FastifyReply } from "fastify";
import {
  adsCsvImportInputSchema,
  adsSyncInputSchema,
  importAdAccountsInputSchema,
  linkAdCampaignInputSchema,
  metricDateSchema,
  type Connection,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { adsAdapterFor, adsExecutionAdapterFor, type AdsAdapter } from "../connectors/ads";
import { ConnectorFabricError, type ConnectorFabric } from "../connectors/fabric";
import {
  defaultMetricRange,
  getAdAccount,
  getAdCampaign,
  getAdsReport,
  importAdAccounts,
  importAdsCsv,
  linkAdCampaign,
  listAdAccounts,
  syncAdAccount,
  type AdsSyncResult,
} from "../services/ads";
import { syncLaunchStatuses } from "../services/ad-launches";
import { getCampaign } from "../services/campaigns";
import { getConnection, providerByKey } from "../services/connections";
import { emitEvent } from "../services/events";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalidInput(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "invalid_input", message });
}

/** Resolve a connected, ads-capable connection to its adapter. */
function adsAdapterOrError(
  db: Db,
  fabric: ConnectorFabric,
  workspaceId: string,
  connectionId: string,
):
  | { ok: true; adapter: AdsAdapter; connection: Connection }
  | { ok: false; status: number; error: string; message: string } {
  const connection = getConnection(db, workspaceId, connectionId);
  if (!connection) {
    return { ok: false, status: 404, error: "connection_not_found", message: "No such connection." };
  }
  const provider = providerByKey(connection.providerKey);
  const adapter = provider ? adsAdapterFor(fabric, provider, connection) : undefined;
  if (!adapter) {
    return {
      ok: false,
      status: 400,
      error: "not_an_ads_connection",
      message: `${provider?.label ?? connection.providerKey} is not an ads connection.`,
    };
  }
  if (connection.status !== "connected") {
    return {
      ok: false,
      status: 400,
      error: "connection_not_connected",
      message: "Reconnect the provider before syncing.",
    };
  }
  return { ok: true, adapter, connection };
}

export function registerAdsRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/ads/accounts", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listAdAccounts(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/ads/accounts/import",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = importAdAccountsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      const resolved = adsAdapterOrError(db, fabric, request.params.id, parsed.data.connectionId);
      if (!resolved.ok) {
        return reply
          .status(resolved.status)
          .send({ error: resolved.error, message: resolved.message });
      }
      try {
        return await importAdAccounts(db, resolved.adapter, request.params.id, resolved.connection.id);
      } catch (err) {
        if (err instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "ads_import_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  async function syncOne(
    workspaceId: string,
    accountId: string,
    since: string,
    until: string,
  ): Promise<
    | { ok: true; result: AdsSyncResult }
    | { ok: false; status: number; error: string; message: string }
  > {
    const account = getAdAccount(db, workspaceId, accountId);
    if (!account) {
      return { ok: false, status: 404, error: "account_not_found", message: "No such ad account." };
    }
    if (!account.connectionId) {
      return {
        ok: false,
        status: 400,
        error: "account_not_syncable",
        message: "This account holds CSV imports only — there is nothing to sync from.",
      };
    }
    const resolved = adsAdapterOrError(db, fabric, workspaceId, account.connectionId);
    if (!resolved.ok) return resolved;
    try {
      const result = await syncAdAccount(db, resolved.adapter, workspaceId, account, since, until);
      // Sprint 20: stamp platform statuses on this account's launches.
      // Best-effort — a status-listing failure never breaks the metric sync.
      const provider = providerByKey(resolved.connection.providerKey);
      const exec = provider
        ? adsExecutionAdapterFor(fabric, provider, resolved.connection)
        : undefined;
      if (exec) {
        try {
          await syncLaunchStatuses(db, exec, workspaceId, account.id, account.externalId);
        } catch {
          // swallowed by design
        }
      }
      if (result.created + result.updated > 0) {
        await emitEvent(db, fetcher, workspaceId, "ads.synced", {
          adAccountId: account.id,
          externalId: account.externalId,
          since,
          until,
          ...result,
        });
      }
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ConnectorFabricError) {
        return { ok: false, status: 502, error: "ads_sync_failed", message: err.message };
      }
      throw err;
    }
  }

  app.post<{ Params: { id: string; accountId: string } }>(
    "/workspaces/:id/ads/accounts/:accountId/sync",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = adsSyncInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      const range = defaultMetricRange();
      const outcome = await syncOne(
        request.params.id,
        request.params.accountId,
        parsed.data.since ?? range.since,
        parsed.data.until ?? range.until,
      );
      if (!outcome.ok) {
        return reply.status(outcome.status).send({ error: outcome.error, message: outcome.message });
      }
      return outcome.result;
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/ads/sync", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = adsSyncInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const range = defaultMetricRange();
    const since = parsed.data.since ?? range.since;
    const until = parsed.data.until ?? range.until;
    const results = [];
    // One bad account never blocks the rest; CSV-only accounts are skipped.
    for (const account of listAdAccounts(db, request.params.id)) {
      if (!account.connectionId) continue;
      const outcome = await syncOne(request.params.id, account.id, since, until);
      results.push(
        outcome.ok
          ? { accountId: account.id, name: account.name, ok: true, ...outcome.result }
          : { accountId: account.id, name: account.name, ok: false, error: outcome.message },
      );
    }
    return { since, until, results };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/ads/import-csv", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = adsCsvImportInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidInput(
        reply,
        parsed.error.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; "),
      );
    }
    return importAdsCsv(db, request.params.id, parsed.data);
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string; until?: string } }>(
    "/workspaces/:id/ads/report",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const range = defaultMetricRange();
      const { since = range.since, until = range.until } = request.query;
      if (!metricDateSchema.safeParse(since).success || !metricDateSchema.safeParse(until).success) {
        return invalidInput(reply, "since/until must be YYYY-MM-DD");
      }
      return getAdsReport(db, request.params.id, since, until);
    },
  );

  app.post<{ Params: { id: string; adCampaignId: string } }>(
    "/workspaces/:id/ads/campaigns/:adCampaignId/link",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = linkAdCampaignInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidInput(reply, parsed.error.issues.map((i) => i.message).join("; "));
      }
      if (!getAdCampaign(db, request.params.id, request.params.adCampaignId)) {
        return reply.status(404).send({ error: "ad_campaign_not_found" });
      }
      if (parsed.data.campaignId && !getCampaign(db, request.params.id, parsed.data.campaignId)) {
        return reply.status(404).send({ error: "campaign_not_found" });
      }
      return linkAdCampaign(db, request.params.id, request.params.adCampaignId, parsed.data.campaignId);
    },
  );
}
