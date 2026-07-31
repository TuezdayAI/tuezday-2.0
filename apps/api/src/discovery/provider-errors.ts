export const PROVIDER_CAPABILITY_CODES = [
  "source_reserved",
  "target_unresolvable",
  "permission_required",
  "reconnect_required",
  "unsupported_target",
  "unsupported_mode",
] as const;

export type ProviderCapabilityCode =
  (typeof PROVIDER_CAPABILITY_CODES)[number];

export class ProviderCapabilityError extends Error {
  constructor(
    public readonly code: ProviderCapabilityCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderCapabilityError";
  }
}
