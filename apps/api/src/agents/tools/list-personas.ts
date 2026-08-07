import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { listPersonas } from "../../services/personas";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.list_personas;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 20;
const DESCRIPTION_CHARS = 300;

/**
 * The workspace's personas. `get_persona` needs an id; a strategy conversation
 * asking "who is this for?" needs the real answer set first — inventing an
 * audience is exactly the failure this tool exists to prevent.
 */
export const listPersonasTool: Tool<Input, unknown> = {
  name: "list_personas",
  description:
    "List the workspace's personas with id, name, description, topics and tone. Use this to resolve an audience the user named in words into its id, or to ground a question about who the workspace targets.",
  input,
  access: "read",
  async run(ctx, { limit }) {
    const personas = await listPersonas(ctx.db, ctx.workspaceId);
    if (personas.length === 0) {
      return { personas: [], note: "This workspace has no personas defined yet." };
    }
    return {
      personas: personas.slice(0, limit ?? DEFAULT_LIMIT).map((p) => ({
        id: p.id,
        name: p.name,
        description: compactText(p.description, DESCRIPTION_CHARS),
        topics: p.topics,
        tone: p.tone,
      })),
      totalCount: personas.length,
    };
  },
};
