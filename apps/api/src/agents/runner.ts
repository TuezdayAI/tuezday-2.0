import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentMessage, AgentStopReason, AgentToolCall } from "@tuezday/contracts";
import type { Db } from "../db/index";
import { agentRuns, agentRunSteps } from "../db/schema";
import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type AgentStepUsage,
  type JsonSchema,
  type LlmGateway,
  type ToolDefinition,
} from "../llm/gateway";
import { costCents } from "../llm/pricing";

/** A tool the runner can dispatch: the model-facing declaration plus the
 * implementation. Sprint 57's registry wraps its Tool objects into this. */
export interface AgentTool {
  definition: ToolDefinition;
  handler: (args: unknown) => Promise<unknown>;
}

/** Thrown by a tool handler to stop the run for human input — the one
 * legitimate way a tool ends a run early. */
export class NeedsHumanSignal extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "NeedsHumanSignal";
  }
}

export interface AgentRunUsage extends AgentStepUsage {
  costCents: number;
}

export type AgentRunEvent =
  | { type: "run_start"; runId: string }
  | { type: "step_start"; stepIndex: number }
  | { type: "text_delta"; stepIndex: number; text: string }
  | { type: "tool_call_start"; stepIndex: number; call: AgentToolCall }
  | { type: "tool_call_end"; stepIndex: number; callId: string; result?: unknown; error?: string }
  | { type: "step_end"; stepIndex: number; usage: AgentStepUsage }
  | { type: "run_end"; stopReason: AgentStopReason; usage: AgentRunUsage };

export interface AgentRunParams {
  workspaceId: string;
  /** Short label persisted on the run, e.g. "proof" or "pipeline:research". */
  task: string;
  /** Actor attribution label, e.g. "user:<id>" or "system". */
  createdBy: string;
  system: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  responseSchema?: JsonSchema;
  maxSteps: number;
  maxTokens: number;
  timeoutMs: number;
  /** Streaming variant: receive deltas, tool dispatch and step boundaries
   * as they happen. Omit for a single awaited result. */
  onEvent?: (event: AgentRunEvent) => void;
}

export interface AgentRunResult {
  runId: string;
  /** Full transcript: input messages plus everything the loop appended. */
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  /** Final text, or the JSON.parsed object when responseSchema was given. */
  output: unknown;
  usage: AgentRunUsage;
  stopReason: AgentStopReason;
  error?: string;
}

/**
 * The agent loop (Sprint 56): call model → dispatch tool calls → append
 * results → repeat until the model answers without tool calls or a bound
 * trips. Every step is persisted as it happens, so a crashed process leaves
 * an inspectable partial trace, and every outcome — including bounds and
 * errors — is a result with a stop reason, never a throw. Only programmer
 * errors (a gateway without agentStep) throw.
 */
export class AgentRunner {
  constructor(
    private readonly db: Db,
    private readonly gateway: LlmGateway,
  ) {}

  async run(params: AgentRunParams): Promise<AgentRunResult> {
    if (!this.gateway.agentStep) {
      throw new Error(
        "AgentRunner requires a gateway with agentStep support (Gateway v2).",
      );
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + params.timeoutMs;
    const emit = params.onEvent ?? (() => {});
    const toolsByName = new Map(
      (params.tools ?? []).map((tool) => [tool.definition.name, tool]),
    );

    this.db
      .insert(agentRuns)
      .values({
        id: runId,
        workspaceId: params.workspaceId,
        task: params.task,
        createdBy: params.createdBy,
        status: "running",
        model: "",
        provider: "",
        system: params.system,
        inputMessages: JSON.stringify(params.messages),
        startedAt,
      })
      .run();
    emit({ type: "run_start", runId });

    const messages: AgentMessage[] = [...params.messages];
    const allToolCalls: AgentToolCall[] = [];
    const usage: AgentRunUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costCents: 0,
    };
    let stepIndex = 0;
    let modelCalls = 0;
    let model = "";
    let provider = "";
    let output: unknown = null;
    let stopReason: AgentStopReason;
    let runError: string | undefined;

    const persistStep = (row: Partial<typeof agentRunSteps.$inferInsert>) => {
      this.db
        .insert(agentRunSteps)
        .values({
          id: randomUUID(),
          runId,
          stepIndex: stepIndex++,
          kind: "model_call",
          createdAt: Date.now(),
          ...row,
        } as typeof agentRunSteps.$inferInsert)
        .run();
    };

    loop: while (true) {
      if (Date.now() >= deadline) {
        stopReason = "timeout";
        break;
      }
      if (usage.inputTokens + usage.outputTokens >= params.maxTokens) {
        stopReason = "max_tokens";
        break;
      }
      if (modelCalls >= params.maxSteps) {
        stopReason = "max_steps";
        break;
      }

      const modelStepIndex = stepIndex;
      emit({ type: "step_start", stepIndex: modelStepIndex });

      const stepParams: AgentStepParams = {
        system: params.system,
        messages,
        tools: params.tools?.map((t) => t.definition),
        responseSchema: params.responseSchema,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      };

      let step: AgentStepResult;
      try {
        if (params.onEvent && this.gateway.agentStepStream) {
          step = await this.gateway.agentStepStream(stepParams, (event) => {
            if (event.type === "text_delta") {
              emit({ type: "text_delta", stepIndex: modelStepIndex, text: event.text });
            }
            // Gateway-level tool_call events become tool_call_start below,
            // once the full call list is known and dispatch actually begins.
          });
        } else {
          step = await this.gateway.agentStep(stepParams);
          if (params.onEvent && step.message.content) {
            emit({ type: "text_delta", stepIndex: modelStepIndex, text: step.message.content });
          }
        }
      } catch (err) {
        if (Date.now() >= deadline || isTimeoutAbort(err)) {
          stopReason = "timeout";
          break;
        }
        if (err instanceof GatewayError) {
          stopReason = "error";
          runError = err.message;
          break;
        }
        throw err;
      }

      modelCalls += 1;
      model = step.model;
      provider = step.provider;
      usage.inputTokens += step.usage.inputTokens;
      usage.outputTokens += step.usage.outputTokens;
      usage.cachedTokens += step.usage.cachedTokens;
      const stepCost = costCents(step.model, step.usage);
      usage.costCents += stepCost;

      messages.push(step.message);
      persistStep({
        kind: "model_call",
        messageJson: JSON.stringify(step.message),
        inputTokens: step.usage.inputTokens,
        outputTokens: step.usage.outputTokens,
        cachedTokens: step.usage.cachedTokens,
        costCents: stepCost,
        durationMs: step.durationMs,
      });
      emit({ type: "step_end", stepIndex: modelStepIndex, usage: step.usage });

      const toolCalls = step.message.toolCalls ?? [];
      if (toolCalls.length === 0) {
        if (params.responseSchema) {
          try {
            output = JSON.parse(step.message.content);
          } catch {
            stopReason = "error";
            runError = "Model final response was not valid JSON for the requested schema.";
            break;
          }
        } else {
          output = step.message.content;
        }
        stopReason = "complete";
        break;
      }

      for (const call of toolCalls) {
        allToolCalls.push(call);
        emit({ type: "tool_call_start", stepIndex, call });
        const tool = toolsByName.get(call.name);
        const dispatchStarted = Date.now();
        let result: unknown;
        let toolError: string | undefined;
        if (!tool) {
          toolError = `Unknown tool "${call.name}".`;
        } else {
          try {
            result = await tool.handler(call.arguments);
          } catch (err) {
            if (err instanceof NeedsHumanSignal) {
              persistStep({
                kind: "tool_call",
                toolName: call.name,
                toolCallId: call.id,
                toolArgsJson: JSON.stringify(call.arguments ?? null),
                toolError: `needs_human: ${err.reason}`,
                durationMs: Date.now() - dispatchStarted,
              });
              emit({ type: "tool_call_end", stepIndex: stepIndex - 1, callId: call.id, error: err.reason });
              stopReason = "needs_human";
              runError = err.reason;
              break loop;
            }
            toolError = err instanceof Error ? err.message : String(err);
          }
        }

        persistStep({
          kind: "tool_call",
          toolName: call.name,
          toolCallId: call.id,
          toolArgsJson: JSON.stringify(call.arguments ?? null),
          toolResultJson: toolError ? null : JSON.stringify(result ?? null),
          toolError: toolError ?? null,
          durationMs: Date.now() - dispatchStarted,
        });
        emit({
          type: "tool_call_end",
          stepIndex: stepIndex - 1,
          callId: call.id,
          ...(toolError ? { error: toolError } : { result }),
        });

        // Tool failures are data the model can react to, not crashes.
        messages.push({
          role: "tool",
          content: toolError ? `Error: ${toolError}` : JSON.stringify(result ?? null),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }

    this.db
      .update(agentRuns)
      .set({
        status: "done",
        stopReason,
        error: runError ?? null,
        model,
        provider,
        outputJson: output === null ? null : JSON.stringify(output),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        costCents: usage.costCents,
        stepCount: stepIndex,
        finishedAt: Date.now(),
      })
      .where(eq(agentRuns.id, runId))
      .run();
    emit({ type: "run_end", stopReason, usage });

    return {
      runId,
      messages,
      toolCalls: allToolCalls,
      output,
      usage,
      stopReason,
      ...(runError ? { error: runError } : {}),
    };
  }
}

function isTimeoutAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}
