import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type AgentStepStreamEvent,
  type EmbedParams,
  type EmbedResult,
  type GenerateParams,
  type GenerateResult,
  type LlmGateway,
} from "./gateway";

/**
 * Tries the primary gateway and degrades to the secondary on any GatewayError
 * — including missing_api_key, so a misconfigured primary degrades instead of
 * hard-failing the user's generation. Non-GatewayError exceptions (programmer
 * errors) rethrow immediately and never trigger a fallback.
 */
export class FallbackGateway implements LlmGateway {
  constructor(
    public readonly primary: LlmGateway,
    public readonly secondary: LlmGateway,
  ) {}

  async generate(params: GenerateParams): Promise<GenerateResult> {
    let primaryError: GatewayError;
    try {
      // result.provider already tells callers/logs who actually served the call.
      return await this.primary.generate(params);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      primaryError = err;
    }

    try {
      return await this.secondary.generate(params);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      // Operators must see the whole story from one error.
      throw new GatewayError(
        "provider_error",
        `All LLM providers failed. Primary: ${primaryError.message} Secondary: ${err.message}`,
      );
    }
  }

  /**
   * Agent steps (Sprint 56) follow the embed() pattern: try each provider
   * that implements the method, degrade on GatewayError, and surface a clear
   * error when neither supports it. OpenRouter implements the interface in a
   * later sprint; until then a Gemini-primary deploy just uses Gemini.
   */
  async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    return await this.agentCall((provider) => provider.agentStep?.(params));
  }

  async agentStepStream(
    params: AgentStepParams,
    onEvent: (event: AgentStepStreamEvent) => void,
  ): Promise<AgentStepResult> {
    // A provider with agentStep but no streaming still serves the call —
    // the caller (AgentRunner) treats streaming as an optimization.
    return await this.agentCall(
      (provider) =>
        provider.agentStepStream?.(params, onEvent) ?? provider.agentStep?.(params),
    );
  }

  private async agentCall(
    invoke: (provider: LlmGateway) => Promise<AgentStepResult> | undefined,
  ): Promise<AgentStepResult> {
    let firstError: GatewayError | undefined;
    for (const provider of [this.primary, this.secondary]) {
      const attempt = invoke(provider);
      if (!attempt) continue;
      try {
        return await attempt;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        firstError ??= error;
      }
    }
    throw (
      firstError ??
      new GatewayError(
        "provider_error",
        "No configured LLM provider supports agent steps.",
      )
    );
  }

  async embed(params: EmbedParams): Promise<EmbedResult> {
    const providers = [this.primary, this.secondary].filter(
      (
        provider,
      ): provider is LlmGateway & Required<Pick<LlmGateway, "embed">> =>
        typeof provider.embed === "function",
    );
    if (providers.length === 0) {
      throw new GatewayError(
        "provider_error",
        "No configured LLM provider supports embeddings.",
      );
    }

    let firstError: GatewayError | undefined;
    for (const provider of providers) {
      try {
        return await provider.embed(params);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        firstError ??= error;
      }
    }
    throw firstError!;
  }
}
