import { eq } from "drizzle-orm";
import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { outreachSequences } from "../../db/schema";
import { getSequenceFunnel } from "../../services/outreach-funnel";
import type { Tool } from "../registry";

const input = toolInputSchemas.get_sequence_funnel;
type Input = z.infer<typeof input>;

/**
 * One outreach sequence's send funnel. `getSequenceFunnel` is already
 * workspace-scoped and returns undefined for a foreign or unknown id, so the
 * not-found branch doubles as the tenant boundary.
 */
export const getSequenceFunnelTool: Tool<Input, unknown> = {
  name: "get_sequence_funnel",
  description:
    "Get one outreach sequence's funnel: sent, opened, clicked, replied, positive replies, meetings and won/lost outcomes, with the derived rates. Requires sequenceId; an unknown id returns the workspace's sequences.",
  input,
  access: "read",
  async run(ctx, { sequenceId }) {
    const funnel = getSequenceFunnel(ctx.db, ctx.workspaceId, sequenceId);
    if (!funnel) {
      const available = ctx.db
        .select({ id: outreachSequences.id, name: outreachSequences.name })
        .from(outreachSequences)
        .where(eq(outreachSequences.workspaceId, ctx.workspaceId))
        .all();
      return {
        error: "not_found",
        note: `No outreach sequence with id ${sequenceId} in this workspace.`,
        availableSequences: available,
      };
    }
    return funnel;
  },
};
