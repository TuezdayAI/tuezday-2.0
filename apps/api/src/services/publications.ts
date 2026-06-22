import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Connection, Publication, PublicationStatus, PublishDraftInput } from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, publications, type PublicationRow } from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor } from "../connectors/social";
import { getConnection, providerByKey } from "./connections";
import { emitEvent } from "./events";

type Fetcher = typeof fetch;

function rowToPublication(row: PublicationRow): Publication {
  return { ...row, status: row.status as PublicationStatus };
}

export interface PublicationWithDraft extends Publication {
  draft: { id: string; taskType: string; channel: string; content: string } | null;
}

export function listPublications(db: Db, workspaceId: string): PublicationWithDraft[] {
  const rows = db
    .select({ publication: publications, draft: drafts })
    .from(publications)
    .leftJoin(drafts, eq(publications.draftId, drafts.id))
    .where(eq(publications.workspaceId, workspaceId))
    .orderBy(desc(publications.createdAt))
    .all();
  return rows.map(({ publication, draft }) => ({
    ...rowToPublication(publication),
    draft: draft
      ? { id: draft.id, taskType: draft.taskType, channel: draft.channel, content: draft.content }
      : null,
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
  cadenceId: string | null = null,
): Promise<Publication> {
  const now = Date.now();
  const row: PublicationRow = {
    id: randomUUID(),
    workspaceId,
    draftId,
    connectionId: connection.id,
    providerKey: connection.providerKey,
    target: input.target,
    title: input.title,
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
    const result = await adapter.publishPost({
      target: row.target,
      title: row.title,
      body: draft.content,
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
  } catch (err) {
    db.update(publications)
      .set({
        status: "failed",
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        updatedAt: Date.now(),
      })
      .where(eq(publications.id, row.id))
      .run();
  }
  return getPublication(db, workspaceId, row.id)!;
}

export interface PublishRunResult {
  id: string;
  ok: boolean;
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
    const outcome = await attemptPublication(db, fabric, fetcher, workspaceId, row.id);
    results.push(
      outcome.status === "published"
        ? { id: row.id, ok: true }
        : { id: row.id, ok: false, error: outcome.lastError ?? "unknown error" },
    );
  }
  return results;
}
