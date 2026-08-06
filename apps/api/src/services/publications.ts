import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type {
  Connection,
  Publication,
  PublicationMetric,
  PublicationStatus,
  PublishDraftInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  campaigns,
  drafts,
  externalActions,
  postingCadences,
  publications,
  type PublicationRow,
} from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor, type PublishMedia } from "../connectors/social";
import { getConnection, providerByKey } from "./connections";
import { emitEvent } from "./events";
import { metricsByPublication } from "./inbox";
import { getSocialAutomationSettings } from "./automation-settings";

type Fetcher = typeof fetch;

function rowToPublication(row: PublicationRow): Publication {
  return { ...row, status: row.status as PublicationStatus };
}

export interface PublicationWithDraft extends Publication {
  draft: { id: string; taskType: string; channel: string; content: string } | null;
  /** Engagement snapshots (24h/7d) on a published post (Sprint 29). */
  metrics: PublicationMetric[];
}

export function listPublications(db: Db, workspaceId: string): PublicationWithDraft[] {
  const rows = db
    .select({ publication: publications, draft: drafts })
    .from(publications)
    .leftJoin(drafts, eq(publications.draftId, drafts.id))
    .where(eq(publications.workspaceId, workspaceId))
    .orderBy(desc(publications.createdAt))
    .all();
  const metrics = metricsByPublication(db, workspaceId);
  return rows.map(({ publication, draft }) => ({
    ...rowToPublication(publication),
    draft: draft
      ? { id: draft.id, taskType: draft.taskType, channel: draft.channel, content: draft.content }
      : null,
    metrics: metrics.get(publication.id) ?? [],
  }));
}

/** Every receipt a cadence has created, soonest scheduled first. */
export function listCadencePublications(
  db: Db,
  workspaceId: string,
  cadenceId: string,
): Publication[] {
  return db
    .select()
    .from(publications)
    .where(and(eq(publications.workspaceId, workspaceId), eq(publications.cadenceId, cadenceId)))
    .orderBy(publications.scheduledFor)
    .all()
    .map(rowToPublication);
}

export function getPublication(
  db: Db,
  workspaceId: string,
  publicationId: string,
): Publication | undefined {
  const row = db
    .select()
    .from(publications)
    .where(and(eq(publications.workspaceId, workspaceId), eq(publications.id, publicationId)))
    .get();
  return row ? rowToPublication(row) : undefined;
}

export function getPublicationByExternalAction(
  db: Db,
  workspaceId: string,
  externalActionId: string,
): Publication | undefined {
  const row = db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.externalActionId, externalActionId),
      ),
    )
    .get();
  return row ? rowToPublication(row) : undefined;
}

/** A live (scheduled or already published) receipt blocks an accidental dupe. */
export function findLivePublication(
  db: Db,
  draftId: string,
  connectionId: string,
  target: string,
): Publication | undefined {
  const row = db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.draftId, draftId),
        eq(publications.connectionId, connectionId),
        eq(publications.target, target),
        inArray(publications.status, ["scheduled", "published"]),
      ),
    )
    .get();
  return row ? rowToPublication(row) : undefined;
}

export function deletePublication(db: Db, publicationId: string): void {
  db.delete(publications).where(eq(publications.id, publicationId)).run();
}

/**
 * Create the receipt row. A future scheduledFor stays `scheduled` for the
 * worker; otherwise the post is attempted synchronously so the caller gets
 * the outcome (published or failed) in one round trip.
 */
export async function createPublication(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  draftId: string,
  connection: Connection,
  input: PublishDraftInput,
  media?: PublishMedia[],
  cadenceId: string | null = null,
  externalActionId: string | null = null,
): Promise<Publication> {
  const now = Date.now();
  if (externalActionId) {
    const existing = getPublicationByExternalAction(db, workspaceId, externalActionId);
    if (existing) {
      if (existing.status === "scheduled" && existing.scheduledFor <= now) {
        return attemptPublication(db, fabric, fetcher, workspaceId, existing.id);
      }
      return existing;
    }
  }
  const row: PublicationRow = {
    id: randomUUID(),
    workspaceId,
    draftId,
    externalActionId,
    connectionId: connection.id,
    providerKey: connection.providerKey,
    target: input.target,
    title: input.title,
    mediaJson: media && media.length > 0 ? JSON.stringify(media) : null,
    cadenceId,
    status: "scheduled",
    scheduledFor: input.scheduledFor ?? now,
    publishedAt: null,
    externalId: null,
    externalUrl: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(publications).values(row).run();
  if (input.scheduledFor && input.scheduledFor > now) {
    return rowToPublication(row);
  }
  return attemptPublication(db, fabric, fetcher, workspaceId, row.id);
}

/**
 * Fire one receipt at the platform. Failures land on the row (`failed` +
 * lastError) instead of throwing — the receipt is the report either way.
 */
export async function attemptPublication(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  publicationId: string,
): Promise<Publication> {
  return (await attemptPublicationDetailed(db, fabric, fetcher, workspaceId, publicationId))
    .publication;
}

export type PublicationRunState = "published" | "processing" | "blocked" | "failed";

interface PublicationAttemptResult {
  publication: Publication;
  state: PublicationRunState;
  error?: string;
}

/**
 * The durable action payload is the strongest automation signal. Cadence and
 * campaign lineage keeps pre-action receipts protected during the migration.
 */
function automatedPublication(db: Db, row: PublicationRow): boolean {
  let campaignId: string | null = null;
  if (row.externalActionId) {
    const action = db
      .select({ payloadJson: externalActions.payloadJson, campaignId: externalActions.campaignId })
      .from(externalActions)
      .where(
        and(
          eq(externalActions.workspaceId, row.workspaceId),
          eq(externalActions.id, row.externalActionId),
        ),
      )
      .get();
    if (action) {
      campaignId = action.campaignId;
      try {
        const payload = JSON.parse(action.payloadJson) as { automated?: unknown };
        if (typeof payload.automated === "boolean") return payload.automated;
      } catch {
        // Fall through to persisted cadence/campaign lineage for older rows.
      }
    }
  }
  if (!campaignId && row.cadenceId) {
    campaignId =
      db
        .select({ campaignId: postingCadences.campaignId })
        .from(postingCadences)
        .where(
          and(
            eq(postingCadences.workspaceId, row.workspaceId),
            eq(postingCadences.id, row.cadenceId),
          ),
        )
        .get()?.campaignId ?? null;
  }
  if (!campaignId) return false;
  return (
    db
      .select({ automationMode: campaigns.automationMode })
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, row.workspaceId), eq(campaigns.id, campaignId)))
      .get()?.automationMode === "scheduled_auto"
  );
}

/** The classified attempt used by scheduled runs and asynchronous providers. */
async function attemptPublicationDetailed(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  publicationId: string,
): Promise<PublicationAttemptResult> {
  const row = db.select().from(publications).where(eq(publications.id, publicationId)).get()!;
  const draft = db.select().from(drafts).where(eq(drafts.id, row.draftId)).get();
  const connection = getConnection(db, workspaceId, row.connectionId);
  const provider = connection ? providerByKey(connection.providerKey) : undefined;
  const adapter =
    connection && provider && connection.status === "connected"
      ? socialAdapterFor(fabric, provider, connection)
      : undefined;

  try {
    if (!draft) throw new Error("The draft behind this publication no longer exists.");
    if (!adapter) {
      throw new Error(
        `The ${row.providerKey} connection is not available — reconnect it on the Integrations page.`,
      );
    }
    // This is deliberately the final synchronous check before the adapter.
    // Earlier scheduling/action guards can race with an emergency stop.
    if (automatedPublication(db, row) && getSocialAutomationSettings(db, workspaceId).killSwitch) {
      return {
        publication: rowToPublication(row),
        state: "blocked",
        error: "kill_switch_on",
      };
    }
    const result = await adapter.publishPost({
      target: row.target,
      title: row.title,
      body: draft.content,
      media: row.mediaJson ? (JSON.parse(row.mediaJson) as PublishMedia[]) : undefined,
    });
    db.update(publications)
      .set({
        status: "published",
        publishedAt: Date.now(),
        externalId: result.externalId,
        externalUrl: result.url,
        lastError: null,
        updatedAt: Date.now(),
      })
      .where(eq(publications.id, row.id))
      .run();
    await emitEvent(db, fetcher, workspaceId, "post.published", {
      publicationId: row.id,
      draftId: row.draftId,
      providerKey: row.providerKey,
      target: row.target,
      title: row.title,
      url: result.url,
    });
    return { publication: getPublication(db, workspaceId, row.id)!, state: "published" };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    db.update(publications)
      .set({
        status: "failed",
        lastError: error,
        updatedAt: Date.now(),
      })
      .where(eq(publications.id, row.id))
      .run();
    return {
      publication: getPublication(db, workspaceId, row.id)!,
      state: "failed",
      error,
    };
  }
}

export interface PublishRunResult {
  id: string;
  ok: boolean;
  state: PublicationRunState;
  error?: string;
}

/** Fire every due scheduled receipt; per-row failures never abort the run. */
export async function runDuePublications(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
): Promise<PublishRunResult[]> {
  const due = db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.status, "scheduled"),
        lte(publications.scheduledFor, Date.now()),
      ),
    )
    .orderBy(publications.scheduledFor)
    .all();

  const results: PublishRunResult[] = [];
  for (const row of due) {
    const outcome = await attemptPublicationDetailed(db, fabric, fetcher, workspaceId, row.id);
    results.push({
      id: row.id,
      ok: outcome.state === "published",
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  return results;
}
