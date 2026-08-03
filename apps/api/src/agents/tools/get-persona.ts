import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { getPersona, listPersonas, toResolvePersona } from "../../services/personas";
import type { Tool } from "../registry";

const input = toolInputSchemas.get_persona;
type Input = z.infer<typeof input>;

/**
 * One persona, in the resolver-facing shape (toResolvePersona — the single
 * mapping point, so tool output can't drift from what generation sees).
 */
export const getPersonaTool: Tool<Input, unknown> = {
  name: "get_persona",
  description:
    "Get one persona's full voice profile: description, overlay, topics, tone, style rules, and what to avoid. Requires personaId; an unknown id returns the available personas.",
  input,
  access: "read",
  async run(ctx, { personaId }) {
    const persona = getPersona(ctx.db, ctx.workspaceId, personaId);
    if (!persona) {
      return {
        error: "not_found",
        note: `No persona with id ${personaId} in this workspace.`,
        availablePersonas: listPersonas(ctx.db, ctx.workspaceId).map((p) => ({
          id: p.id,
          name: p.name,
        })),
      };
    }
    return { id: persona.id, ...toResolvePersona(persona) };
  },
};
