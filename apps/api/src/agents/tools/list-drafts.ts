import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { listDrafts } from "../../services/drafts";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.list_drafts;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 10;
const CONTENT_CHARS = 600;

/**
 * The approval queue as data (Sprint 77, D-77.8).
 *
 * Sprint 76's two draft-shaped tools — `find_similar_approved_drafts` and
 * `find_instructive_rejections` — return past *decisions* as training examples.
 * Neither can answer "what is waiting for me", which is the question a founder
 * opens this product with. A general registry read rather than a chat-only one:
 * a pipeline step deciding whether to write more, or a critic checking what is
 * already queued, wants the same rows.
 */
export const listDraftsTool: Tool<Input, unknown> = {
  name: "list_drafts",
  description:
    "List the workspace's drafts with id, state, channel, task type and content. Use `state: \"pending_review\"` to see what is waiting in the founder's approval queue, `\"approved\"` for content that is cleared and publishable. Filter by campaign or channel when the question is scoped to one.",
  input,
  access: "read",
  async run(ctx, { state, campaignId, channel, limit }) {
    const all = await listDrafts(ctx.db, ctx.workspaceId, state, campaignId);
    const filtered = channel ? all.filter((d) => d.channel === channel) : all;
    if (filtered.length === 0) {
      return {
        drafts: [],
        note: state
          ? `No drafts in state "${state}"${channel ? ` on ${channel}` : ""}.`
          : "This workspace has no drafts yet.",
      };
    }
    return {
      drafts: filtered.slice(0, limit ?? DEFAULT_LIMIT).map((d) => ({
        id: d.id,
        state: d.state,
        channel: d.channel,
        taskType: d.taskType,
        campaignId: d.campaignId,
        personaId: d.personaId,
        content: compactText(d.content, CONTENT_CHARS),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      totalCount: filtered.length,
    };
  },
};
