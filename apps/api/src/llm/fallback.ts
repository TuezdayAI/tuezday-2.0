import { GatewayError, type GenerateParams, type GenerateResult, type LlmGateway } from "./gateway";

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
}
