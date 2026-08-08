import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentMessage, AgentStopReason, AgentToolCall, ModelTier } from "@tuezday/contracts";
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

/**
 * What the step-boundary hook may do (Sprint 79). Returning nothing is the
 * common case; the two powers are injecting a human's mid-flight words before
 * the next model call, and stopping the run outright.
 */
export interface StepBoundaryDecision {
  /** Appended to the transcript before the next model call, and persisted as
   * `steer` steps so the interruption is visible where it happened. */
  inject?: AgentMessage[];
  /** Stop now. The run ends `cancelled` with its partial trace intact. */
  cancel?: boolean;
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
  /** Pre-minted run id (Sprint 69). The engine needs the id *before* the run
   * starts so a propose tool can attribute its proposal to it; omitted, the
   * runner mints its own as before. */
  runId?: string;
  /** Short label persisted on the run, e.g. "proof" or "pipeline:research". */
  task: string;
  /** Sprint 79: the run that delegated this one. Set on a subagent so the
   * Inspector can render workers as children of the run that spawned them. */
  parentRunId?: string;
  /** Actor attribution label, e.g. "user:<id>" or "system". */
  createdBy: string;
  system: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  responseSchema?: JsonSchema;
  maxSteps: number;
  maxTokens: number;
  timeoutMs: number;
  /** Model tier for every step of this run (Sprint 59); omitted = "frontier".
   * Sprint 64's pipeline steps declare their tier through this seam. */
  tier?: ModelTier;
  /** Streaming variant: receive deltas, tool dispatch and step boundaries
   * as they happen. Omit for a single awaited result. */
  onEvent?: (event: AgentRunEvent) => void;
  /**
   * Sprint 79 (D-79.8): abort the run from outside. An in-flight model call is
   * aborted with it, so a cancel lands within a step rather than at the next
   * bound. Everything persisted up to that point stays.
   */
  signal?: AbortSignal;
  /**
   * Sprint 79: called before each model call. This is where a long-lived
   * caller renews its lease, drains steering messages, and notices a cancel
   * request — none of which the runner should know anything about. Awaited, so
   * a slow hook delays the next step rather than racing it.
   */
  onStepBoundary?: (info: {
    stepIndex: number;
    modelCalls: number;
  }) => Promise<StepBoundaryDecision | void>;
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

    const runId = params.runId ?? randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + params.timeoutMs;
    const emit = params.onEvent ?? (() => {});
    const toolsByName = new Map(
      (params.tools ?? []).map((tool) => [tool.definition.name, tool]),
    );

    await this.db
      .insert(agentRuns)
      .values({
        id: runId,
        workspaceId: params.workspaceId,
        task: params.task,
        createdBy: params.createdBy,
        parentRunId: params.parentRunId ?? null,
        status: "running",
        model: "",
        provider: "",
        system: params.system,
        inputMessages: JSON.stringify(params.messages),
        startedAt,
      });
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

    const persistStep = async (row: Partial<typeof agentRunSteps.$inferInsert>) => {
      await this.db
        .insert(agentRunSteps)
        .values({
          id: randomUUID(),
          runId,
          stepIndex: stepIndex++,
          kind: "model_call",
          createdAt: Date.now(),
          ...row,
        } as typeof agentRunSteps.$inferInsert);
    };

    loop: while (true) {
      if (params.signal?.aborted) {
        stopReason = "cancelled";
        break;
      }
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

      // Sprint 79: the caller's chance to renew a lease, inject a human's
      // mid-flight words, or stop. Deliberately before the model call — a
      // steer applied after this step's tool calls would have the model
      // reacting to results it was just told to stop caring about (D-79.7).
      if (params.onStepBoundary) {
        const decision = (await params.onStepBoundary({ stepIndex, modelCalls })) ?? {};
        for (const injected of decision.inject ?? []) {
          messages.push(injected);
          await persistStep({
            kind: "steer",
            messageJson: JSON.stringify(injected),
          });
        }
        if (decision.cancel) {
          stopReason = "cancelled";
          break;
        }
      }

      const modelStepIndex = stepIndex;
      emit({ type: "step_start", stepIndex: modelStepIndex });

      const stepDeadline = deadlineSignal(deadline, params.signal);
      const stepParams: AgentStepParams = {
        system: params.system,
        messages,
        tools: params.tools?.map((t) => t.definition),
        responseSchema: params.responseSchema,
        signal: stepDeadline.signal,
        tier: params.tier,
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
        // Cancellation aborts the same signal a timeout does, so the cause has
        // to be read from the caller's signal rather than from the error.
        if (params.signal?.aborted) {
          stopReason = "cancelled";
          break;
        }
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
      } finally {
        stepDeadline.cleanup();
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
      await persistStep({
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
              await persistStep({
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

        await persistStep({
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

        // A cancel that arrives during a slow tool should not wait for the
        // rest of this step's calls to finish (D-79.8). The results already
        // gathered are persisted; the step is simply cut short.
        if (params.signal?.aborted) {
          stopReason = "cancelled";
          break loop;
        }
      }
    }

    await this.db
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
      .where(eq(agentRuns.id, runId));
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

/**
 * The signal one model call runs under: the run's remaining wall-clock, plus
 * the caller's cancellation if it supplied one. Hand-rolled rather than
 * `AbortSignal.any` so the listener is removed when the step ends — a run with
 * forty steps would otherwise leave forty listeners on a signal that outlives
 * all of them.
 */
function deadlineSignal(
  deadline: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  if (!external) return { signal: timeout, cleanup: () => {} };

  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onTimeout = () => abortFrom(timeout);
  const onExternal = () => abortFrom(external);
  timeout.addEventListener("abort", onTimeout, { once: true });
  external.addEventListener("abort", onExternal, { once: true });
  if (external.aborted) abortFrom(external);

  return {
    signal: controller.signal,
    cleanup: () => {
      timeout.removeEventListener("abort", onTimeout);
      external.removeEventListener("abort", onExternal);
    },
  };
}
