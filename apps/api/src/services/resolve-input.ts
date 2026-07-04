import type { BrainDocType, DocOutline, ResolvedTaskDocMatrix } from "@tuezday/contracts";
import type { Db } from "../db";
import { getBrainOutlines } from "./brain";
import { resolveTaskDocMatrix } from "./context-matrix";

export interface SelectiveContextInputs {
  matrix: ResolvedTaskDocMatrix;
  outlines: Partial<Record<BrainDocType, DocOutline>>;
}

/**
 * The Sprint 43 resolver inputs every resolveContext call site passes: the
 * workspace's merged task matrix and the per-doc outlines. One helper so no
 * call site can drift to a different selection policy.
 */
export function selectiveContextInputs(db: Db, workspaceId: string): SelectiveContextInputs {
  return {
    matrix: resolveTaskDocMatrix(db, workspaceId),
    outlines: getBrainOutlines(db, workspaceId),
  };
}
