import { jsonSchemaFor } from "./json-schema";
import type { AnyTool, ToolContext } from "./registry";
import type { AgentTool } from "./runner";

/** Defensive whole-result bound. Tools own field-level compaction
 * (compactText); this is the structural safety net so no single tool result
 * can flood the transcript and the context window. */
const RESULT_SIZE_LIMIT = 40_000;

/**
 * Wrap registry tools into the runner's AgentTool shape for one run:
 * derived JSON Schema for the model, then per call — budget check, zod
 * validation, dispatch. Validation failures and budget exhaustion return as
 * error DATA (the model reacts and retries or wraps up); thrown errors
 * propagate to the runner, which already records them as tool errors per the
 * Sprint 56 rule, and NeedsHumanSignal passes through untouched.
 *
 * Budget state is per invocation of this function — call it once per run.
 */
export function toAgentTools(tools: readonly AnyTool[], ctx: ToolContext): AgentTool[] {
  let totalCalls = 0;
  const perToolCalls = new Map<string, number>();

  return tools.map((tool) => ({
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchemaFor(tool.input),
    },
    handler: async (args: unknown) => {
      const used = perToolCalls.get(tool.name) ?? 0;
      const perToolCap = ctx.budget.perTool?.[tool.name];
      if (totalCalls >= ctx.budget.maxCalls) {
        return {
          error: "tool_budget_exhausted",
          tool: tool.name,
          callsUsed: totalCalls,
          maxCalls: ctx.budget.maxCalls,
          note: "The run's total tool budget is spent. Answer with what you have.",
        };
      }
      if (perToolCap !== undefined && used >= perToolCap) {
        return {
          error: "tool_budget_exhausted",
          tool: tool.name,
          callsUsed: used,
          maxCalls: perToolCap,
          note: `No more ${tool.name} calls in this run. Answer with what you have.`,
        };
      }
      totalCalls += 1;
      perToolCalls.set(tool.name, used + 1);

      const parsed = tool.input.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          error: "invalid_arguments",
          tool: tool.name,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        };
      }

      const result = await tool.run(ctx, parsed.data);
      if (JSON.stringify(result ?? null).length > RESULT_SIZE_LIMIT) {
        return {
          error: "result_too_large",
          tool: tool.name,
          note: "Narrow the query (lower limit, more specific terms) and retry.",
        };
      }
      return result;
    },
  }));
}
