// Provider-agnostic LLM gateway. Routes and services depend only on this
// interface — switching or adding providers must never touch them.

export interface GenerateParams {
  prompt: string;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
}

export interface LlmGateway {
  generate(params: GenerateParams): Promise<GenerateResult>;
}

export type GatewayErrorCode = "missing_api_key" | "provider_error";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
