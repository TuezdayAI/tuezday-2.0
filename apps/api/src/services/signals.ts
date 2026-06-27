import { randomUUID } from "node:crypto";
import { desc, eq, inArray, and } from "drizzle-orm";
import type {
  ApprovalState,
  Channel,
  CreateSignalInput,
  Signal,
  SignalSource,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, signals, type SignalRow } from "../db/schema";

function rowToSignal(row: SignalRow): Signal {
  return { ...row, source: row.source as SignalSource };
}

export function createSignal(db: Db, workspaceId: string, input: CreateSignalInput): Signal {
  const row: SignalRow = {
    id: randomUUID(),
    workspaceId,
    content: input.content,
    source: input.source,
    sourceUrl: input.sourceUrl ?? null,
    suggestedPersonaId: input.suggestedPersonaId ?? null,
    suggestedCampaignId: input.suggestedCampaignId ?? null,
    createdAt: Date.now(),
  };
  db.insert(signals).values(row).run();
  return rowToSignal(row);
}

export function getSignal(db: Db, workspaceId: string, signalId: string): Signal | undefined {
  const row = db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId)))
    .get();
  return row ? rowToSignal(row) : undefined;
}

export interface SignalDraftSummary {
  id: string;
  state: ApprovalState;
  channel: Channel;
  createdAt: number;
}

export interface SignalWithDrafts extends Signal {
  drafts: SignalDraftSummary[];
}

export function listSignals(db: Db, workspaceId: string): SignalWithDrafts[] {
  const signalRows = db
    .select()
    .from(signals)
    .where(eq(signals.workspaceId, workspaceId))
    .orderBy(desc(signals.createdAt))
    .all();
  if (signalRows.length === 0) return [];

  const draftRows = db
    .select({
      id: drafts.id,
      state: drafts.state,
      channel: drafts.channel,
      createdAt: drafts.createdAt,
      sourceSignalId: drafts.sourceSignalId,
    })
    .from(drafts)
    .where(
      inArray(
        drafts.sourceSignalId,
        signalRows.map((s) => s.id),
      ),
    )
    .all();

  return signalRows.map((row) => ({
    ...rowToSignal(row),
    drafts: draftRows
      .filter((d) => d.sourceSignalId === row.id)
      .map((d) => ({
        id: d.id,
        state: d.state as ApprovalState,
        channel: d.channel as Channel,
        createdAt: d.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  }));
}
