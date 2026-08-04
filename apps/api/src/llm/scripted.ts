import type { AgentMessage, AgentToolCall } from "@tuezday/contracts";
import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type AgentStepStreamEvent,
  type AgentStepUsage,
  type GenerateParams,
  type GenerateResult,
  type LlmGateway,
} from "./gateway";

/** One canned model response in a script. */
export interface ScriptedStep {
  /** Assistant text (defaults to ""). */
  text?: string;
  /** Tool calls the "model" requests this step. Ids minted if omitted. */
  toolCalls?: Array<Pick<AgentToolCall, "name" | "arguments"> & { id?: string }>;
  /** Per-step usage (defaults to 10 in / 5 out / 0 cached). */
  usage?: Partial<AgentStepUsage>;
  /** Simulated model latency — lets timeout tests run deterministically. */
  delayMs?: number;
}

const DEFAULT_USAGE: AgentStepUsage = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };

/**
 * The Sprint 56 testing contract: a gateway that replays a canned sequence of
 * agent steps, so every agent-loop step is deterministically testable with no
 * network. Records every received AgentStepParams for assertions. Throws when
 * the script is exhausted — a test that over-calls the model is a bug.
 */
export class ScriptedGateway implements LlmGateway {
  /** Every AgentStepParams received, in order — assert prompts/tools/history. */
  readonly calls: AgentStepParams[] = [];
  private cursor = 0;
  private mintedIds = 0;

  constructor(private readonly script: ScriptedStep[]) {}

  async generate(_params: GenerateParams): Promise<GenerateResult> {
    throw new GatewayError(
      "provider_error",
      "ScriptedGateway scripts agent steps only — use a generate() fake for generation tests.",
    );
  }

  async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    return this.next(params);
  }

  async agentStepStream(
    params: AgentStepParams,
    onEvent: (event: AgentStepStreamEvent) => void,
  ): Promise<AgentStepResult> {
    const result = await this.next(params);
    // Re-emit the text in two deltas (when splittable) so tests prove real
    // incremental delivery, then the tool calls, mirroring provider order.
    const text = result.message.content;
    if (text.length > 1) {
      const mid = Math.ceil(text.length / 2);
      onEvent({ type: "text_delta", text: text.slice(0, mid) });
      onEvent({ type: "text_delta", text: text.slice(mid) });
    } else if (text.length === 1) {
      onEvent({ type: "text_delta", text });
    }
    for (const call of result.message.toolCalls ?? []) {
      onEvent({ type: "tool_call", call });
    }
    return result;
  }

  private async next(params: AgentStepParams): Promise<AgentStepResult> {
    // Snapshot the history — the runner mutates its messages array in place,
    // and recorded calls must reflect what the model saw at the time.
    this.calls.push({ ...params, messages: [...params.messages] });
    const step = this.script[this.cursor];
    if (!step) {
      throw new GatewayError(
        "provider_error",
        `ScriptedGateway script exhausted after ${this.cursor} steps.`,
      );
    }
    this.cursor += 1;

    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        params.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(params.signal!.reason ?? new Error("aborted"));
        });
      });
    }
    if (params.signal?.aborted) throw params.signal.reason ?? new Error("aborted");

    const toolCalls: AgentToolCall[] | undefined = step.toolCalls?.map((call) => ({
      id: call.id ?? `scripted_call_${++this.mintedIds}`,
      name: call.name,
      arguments: call.arguments,
    }));
    const message: AgentMessage = {
      role: "assistant",
      content: step.text ?? "",
      ...(toolCalls?.length ? { toolCalls } : {}),
    };
    return {
      message,
      usage: { ...DEFAULT_USAGE, ...step.usage },
      model: "scripted",
      provider: "scripted",
      durationMs: step.delayMs ?? 0,
    };
  }
}
