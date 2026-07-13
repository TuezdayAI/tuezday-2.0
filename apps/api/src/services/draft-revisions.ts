import { randomUUID } from "node:crypto";
import { and, asc, eq, gte } from "drizzle-orm";
import {
  draftRevisionTurnSchema,
  type DraftRevisionTurn,
  type EditorContextSection,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { draftRevisionTurns, type DraftRevisionTurnRow } from "../db/schema";

function rowToTurn(row: DraftRevisionTurnRow): DraftRevisionTurn {
  return draftRevisionTurnSchema.parse({
    ...row,
    contextSections: JSON.parse(row.sectionsJson) as EditorContextSection[],
  });
}

export interface CreateRunningTurnInput {
  requestId: string;
  workspaceId: string;
  draftId: string;
  actorId: string | null;
  instruction: string;
  sourceContent: string;
}

export function createRunningTurn(
  db: Db,
  input: CreateRunningTurnInput,
  now = Date.now(),
): DraftRevisionTurn {
  const row: DraftRevisionTurnRow = {
    id: randomUUID(),
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    actorId: input.actorId,
    instruction: input.instruction,
    sourceContent: input.sourceContent,
    resultContent: null,
    sectionsJson: "[]",
    status: "running",
    error: null,
    model: null,
    provider: null,
    durationMs: null,
    createdAt: now,
    completedAt: null,
  };
  db.insert(draftRevisionTurns).values(row).run();
  return rowToTurn(row);
}

export interface CompleteTurnInput {
  resultContent: string;
  contextSections: EditorContextSection[];
  model: string;
  provider: string;
  durationMs: number;
}

export function completeTurn(
  db: Db,
  workspaceId: string,
  turnId: string,
  input: CompleteTurnInput,
  now = Date.now(),
): DraftRevisionTurn {
  db.update(draftRevisionTurns)
    .set({
      resultContent: input.resultContent,
      sectionsJson: JSON.stringify(input.contextSections),
      status: "completed",
      error: null,
      model: input.model,
      provider: input.provider,
      durationMs: input.durationMs,
      completedAt: now,
    })
    .where(and(eq(draftRevisionTurns.id, turnId), eq(draftRevisionTurns.workspaceId, workspaceId)))
    .run();
  const row = getTurn(db, workspaceId, turnId);
  if (!row) throw new Error("draft_revision_turn_not_found");
  return row;
}

export function failTurn(
  db: Db,
  workspaceId: string,
  turnId: string,
  error: string,
  now = Date.now(),
): DraftRevisionTurn {
  db.update(draftRevisionTurns)
    .set({
      resultContent: null,
      status: "failed",
      error: error.slice(0, 500),
      model: null,
      provider: null,
      durationMs: null,
      completedAt: now,
    })
    .where(and(eq(draftRevisionTurns.id, turnId), eq(draftRevisionTurns.workspaceId, workspaceId)))
    .run();
  const row = getTurn(db, workspaceId, turnId);
  if (!row) throw new Error("draft_revision_turn_not_found");
  return row;
}

function getTurn(db: Db, workspaceId: string, turnId: string): DraftRevisionTurn | undefined {
  const row = db
    .select()
    .from(draftRevisionTurns)
    .where(and(eq(draftRevisionTurns.workspaceId, workspaceId), eq(draftRevisionTurns.id, turnId)))
    .get();
  return row ? rowToTurn(row) : undefined;
}

export function getTurnByRequest(
  db: Db,
  workspaceId: string,
  draftId: string,
  requestId: string,
): DraftRevisionTurn | undefined {
  const row = db
    .select()
    .from(draftRevisionTurns)
    .where(
      and(
        eq(draftRevisionTurns.workspaceId, workspaceId),
        eq(draftRevisionTurns.draftId, draftId),
        eq(draftRevisionTurns.requestId, requestId),
      ),
    )
    .get();
  return row ? rowToTurn(row) : undefined;
}

export function listRevisionTurns(
  db: Db,
  workspaceId: string,
  draftId: string,
): DraftRevisionTurn[] {
  return db
    .select()
    .from(draftRevisionTurns)
    .where(
      and(
        eq(draftRevisionTurns.workspaceId, workspaceId),
        eq(draftRevisionTurns.draftId, draftId),
      ),
    )
    .orderBy(asc(draftRevisionTurns.createdAt))
    .all()
    .map(rowToTurn);
}

export function countCompletedRevisionTurnsSince(
  db: Db,
  workspaceId: string,
  sinceMs: number,
): number {
  return db
    .select({ id: draftRevisionTurns.id })
    .from(draftRevisionTurns)
    .where(
      and(
        eq(draftRevisionTurns.workspaceId, workspaceId),
        eq(draftRevisionTurns.status, "completed"),
        gte(draftRevisionTurns.completedAt, sinceMs),
      ),
    )
    .all().length;
}
