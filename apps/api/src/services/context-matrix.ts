import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_TASK_DOC_MATRIX,
  DOC_CONTEXT_MODES,
  MATRIX_DOC_TYPES,
  TASK_TYPES,
  type DocContextMode,
  type MatrixCell,
  type MatrixDocType,
  type ResolvedTaskDocMatrix,
  type TaskType,
  type UpdateMatrixCellInput,
} from "@tuezday/contracts";
import { defaultResolvedMatrix } from "@tuezday/brain";
import type { Db } from "../db";
import { contextMatrixOverrides } from "../db/schema";

/**
 * The Tier-2 task matrix in effect for a workspace: contracts defaults with
 * any `context_matrix_overrides` rows overlaid. Rows with values outside the
 * current vocabularies are ignored rather than trusted.
 */
export async function resolveTaskDocMatrix(db: Db, workspaceId: string): Promise<ResolvedTaskDocMatrix> {
  const matrix = defaultResolvedMatrix();
  const rows = await db
    .select()
    .from(contextMatrixOverrides)
    .where(eq(contextMatrixOverrides.workspaceId, workspaceId));
  for (const row of rows) {
    if (!(TASK_TYPES as readonly string[]).includes(row.taskType)) continue;
    if (!(MATRIX_DOC_TYPES as readonly string[]).includes(row.docType)) continue;
    if (!(DOC_CONTEXT_MODES as readonly string[]).includes(row.mode)) continue;
    const taskType = row.taskType as TaskType;
    const docType = row.docType as MatrixDocType;
    matrix[taskType][docType] = {
      mode: row.mode as DocContextMode,
      reason: row.reason?.trim() || DEFAULT_TASK_DOC_MATRIX[taskType][docType].reason,
      source: "workspace",
    };
  }
  return matrix;
}

/** Flat merged view for the matrix editor: every cell, canonical order. */
export async function listMatrixCells(db: Db, workspaceId: string): Promise<MatrixCell[]> {
  const rows = await db
    .select()
    .from(contextMatrixOverrides)
    .where(eq(contextMatrixOverrides.workspaceId, workspaceId));
  const updatedAtByCell = new Map(rows.map((r) => [`${r.taskType}:${r.docType}`, r.updatedAt]));
  const matrix = await resolveTaskDocMatrix(db, workspaceId);
  return TASK_TYPES.flatMap((taskType) =>
    MATRIX_DOC_TYPES.map((docType) => ({
      taskType,
      docType,
      ...matrix[taskType][docType],
      updatedAt: updatedAtByCell.get(`${taskType}:${docType}`) ?? null,
    })),
  );
}

/** Create or update one cell's override; returns the merged cell. */
export async function setMatrixCell(
  db: Db,
  workspaceId: string,
  taskType: TaskType,
  docType: MatrixDocType,
  input: UpdateMatrixCellInput,
): Promise<MatrixCell> {
  const now = Date.now();
  const existing = (await db
    .select({ id: contextMatrixOverrides.id })
    .from(contextMatrixOverrides)
    .where(
      and(
        eq(contextMatrixOverrides.workspaceId, workspaceId),
        eq(contextMatrixOverrides.taskType, taskType),
        eq(contextMatrixOverrides.docType, docType),
      ),
    ))[0];
  const reason = input.reason?.trim() || null;
  if (existing) {
    await db.update(contextMatrixOverrides)
      .set({ mode: input.mode, reason, updatedAt: now })
      .where(eq(contextMatrixOverrides.id, existing.id));
  } else {
    await db.insert(contextMatrixOverrides)
      .values({
        id: randomUUID(),
        workspaceId,
        taskType,
        docType,
        mode: input.mode,
        reason,
        createdAt: now,
        updatedAt: now,
      });
  }
  return {
    taskType,
    docType,
    mode: input.mode,
    reason: reason ?? DEFAULT_TASK_DOC_MATRIX[taskType][docType].reason,
    source: "workspace",
    updatedAt: now,
  };
}

/** Delete one cell's override; returns the now-default cell. */
export async function resetMatrixCell(
  db: Db,
  workspaceId: string,
  taskType: TaskType,
  docType: MatrixDocType,
): Promise<MatrixCell> {
  await db.delete(contextMatrixOverrides)
    .where(
      and(
        eq(contextMatrixOverrides.workspaceId, workspaceId),
        eq(contextMatrixOverrides.taskType, taskType),
        eq(contextMatrixOverrides.docType, docType),
      ),
    );
  return {
    taskType,
    docType,
    ...DEFAULT_TASK_DOC_MATRIX[taskType][docType],
    source: "default",
    updatedAt: null,
  };
}
