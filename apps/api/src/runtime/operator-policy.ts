export interface DiscoveryOperatorPolicy {
  maxJobsPerTick: number;
  tickTimeoutMs: number;
  sourceTimeoutMs: number;
  maxItemsPerSource: number;
  maxPagesPerSource: number;
  maxCallsPerSource: number;
  maxResponseBytes: number;
  maxBytesPerSource: number;
  maxMatchingItemsPerTick: number;
  matchingTimeoutMs: number;
  leaseMs: number;
  heartbeatMs: number;
  // Sprint 61: story → campaign-opportunity routing bounds.
  maxRoutingStoriesPerTick: number;
  routingTimeoutMs: number;
}

export const DEFAULT_DISCOVERY_POLICY = Object.freeze({
  maxJobsPerTick: 5,
  tickTimeoutMs: 180_000,
  sourceTimeoutMs: 60_000,
  maxItemsPerSource: 100,
  maxPagesPerSource: 4,
  maxCallsPerSource: 20,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBytesPerSource: 10 * 1024 * 1024,
  maxMatchingItemsPerTick: 20,
  matchingTimeoutMs: 45_000,
  leaseMs: 45_000,
  heartbeatMs: 10_000,
  maxRoutingStoriesPerTick: 10,
  routingTimeoutMs: 45_000,
} satisfies DiscoveryOperatorPolicy);

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const normalized = raw.trim();
  const value = Number(normalized);
  if (
    normalized.length === 0 ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value)
  ) {
    throw new Error(`${name} must be a finite integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export function parseDiscoveryOperatorPolicy(
  env: NodeJS.ProcessEnv,
): DiscoveryOperatorPolicy {
  const policy: DiscoveryOperatorPolicy = {
    maxJobsPerTick: boundedInteger(
      env,
      "DISCOVERY_TICK_MAX_JOBS",
      DEFAULT_DISCOVERY_POLICY.maxJobsPerTick,
      1,
      25,
    ),
    tickTimeoutMs: boundedInteger(
      env,
      "DISCOVERY_TICK_TIMEOUT_MS",
      DEFAULT_DISCOVERY_POLICY.tickTimeoutMs,
      10_000,
      600_000,
    ),
    sourceTimeoutMs: boundedInteger(
      env,
      "DISCOVERY_SOURCE_TIMEOUT_MS",
      DEFAULT_DISCOVERY_POLICY.sourceTimeoutMs,
      5_000,
      180_000,
    ),
    maxItemsPerSource: boundedInteger(
      env,
      "DISCOVERY_SOURCE_MAX_ITEMS",
      DEFAULT_DISCOVERY_POLICY.maxItemsPerSource,
      1,
      500,
    ),
    maxPagesPerSource: boundedInteger(
      env,
      "DISCOVERY_SOURCE_MAX_PAGES",
      DEFAULT_DISCOVERY_POLICY.maxPagesPerSource,
      1,
      20,
    ),
    maxCallsPerSource: boundedInteger(
      env,
      "DISCOVERY_SOURCE_MAX_CALLS",
      DEFAULT_DISCOVERY_POLICY.maxCallsPerSource,
      1,
      100,
    ),
    maxResponseBytes: boundedInteger(
      env,
      "DISCOVERY_RESPONSE_MAX_BYTES",
      DEFAULT_DISCOVERY_POLICY.maxResponseBytes,
      64 * 1024,
      8 * 1024 * 1024,
    ),
    maxBytesPerSource: boundedInteger(
      env,
      "DISCOVERY_SOURCE_MAX_BYTES",
      DEFAULT_DISCOVERY_POLICY.maxBytesPerSource,
      256 * 1024,
      32 * 1024 * 1024,
    ),
    maxMatchingItemsPerTick: boundedInteger(
      env,
      "DISCOVERY_MATCH_MAX_ITEMS",
      DEFAULT_DISCOVERY_POLICY.maxMatchingItemsPerTick,
      1,
      100,
    ),
    matchingTimeoutMs: boundedInteger(
      env,
      "DISCOVERY_MATCH_TIMEOUT_MS",
      DEFAULT_DISCOVERY_POLICY.matchingTimeoutMs,
      5_000,
      120_000,
    ),
    leaseMs: boundedInteger(
      env,
      "DISCOVERY_LEASE_MS",
      DEFAULT_DISCOVERY_POLICY.leaseMs,
      15_000,
      300_000,
    ),
    heartbeatMs: boundedInteger(
      env,
      "DISCOVERY_HEARTBEAT_MS",
      DEFAULT_DISCOVERY_POLICY.heartbeatMs,
      2_000,
      60_000,
    ),
    maxRoutingStoriesPerTick: boundedInteger(
      env,
      "DISCOVERY_ROUTING_MAX_STORIES",
      DEFAULT_DISCOVERY_POLICY.maxRoutingStoriesPerTick,
      1,
      100,
    ),
    routingTimeoutMs: boundedInteger(
      env,
      "DISCOVERY_ROUTING_TIMEOUT_MS",
      DEFAULT_DISCOVERY_POLICY.routingTimeoutMs,
      5_000,
      120_000,
    ),
  };

  if (policy.sourceTimeoutMs >= policy.tickTimeoutMs) {
    throw new Error(
      "The discovery source timeout must stay below the tick timeout.",
    );
  }
  if (policy.matchingTimeoutMs >= policy.tickTimeoutMs) {
    throw new Error(
      "The discovery matching timeout must stay below the tick timeout.",
    );
  }
  if (policy.routingTimeoutMs >= policy.tickTimeoutMs) {
    throw new Error(
      "The opportunity routing timeout must stay below the tick timeout.",
    );
  }
  if (policy.heartbeatMs * 2 >= policy.leaseMs) {
    throw new Error(
      "DISCOVERY_HEARTBEAT_MS must be less than half of DISCOVERY_LEASE_MS.",
    );
  }

  return policy;
}
