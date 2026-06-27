import type { DiscoverySourceConfig } from "@tuezday/contracts";
import { NeedsApiKeyError, type RawDiscoveredItem } from "./adapters";

/**
 * Boundary for intent-signal providers (job changes / hiring / funding).
 * Scaffolded in Sprint 31: the `intent` source type routes through this, but
 * no live provider is wired this sprint (the founder chose "keyless funding-news
 * now + scaffold the boundary"). Plugging a real provider in later is a single
 * implementation — `isConfigured()` flips intent sources live, and
 * `fetchSignals` returns normalized items into the existing pipeline.
 */
export interface IntentProvider {
  /** Whether a real provider + credentials are wired. */
  isConfigured(): boolean;
  fetchSignals(config: DiscoverySourceConfig): Promise<RawDiscoveredItem[]>;
}

/** Default: no provider wired. Intent sources stay inert (needs_api_key). */
export class NullIntentProvider implements IntentProvider {
  isConfigured(): boolean {
    return false;
  }

  async fetchSignals(): Promise<RawDiscoveredItem[]> {
    throw new NeedsApiKeyError("intent");
  }
}
