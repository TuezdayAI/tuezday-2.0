import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_POLICY,
  parseDiscoveryOperatorPolicy,
  type DiscoveryOperatorPolicy,
} from "../src/runtime/operator-policy";

const cases = [
  ["maxJobsPerTick", "DISCOVERY_TICK_MAX_JOBS", 5, 1, 25],
  ["tickTimeoutMs", "DISCOVERY_TICK_TIMEOUT_MS", 180_000, 10_000, 600_000],
  ["sourceTimeoutMs", "DISCOVERY_SOURCE_TIMEOUT_MS", 60_000, 5_000, 180_000],
  ["maxItemsPerSource", "DISCOVERY_SOURCE_MAX_ITEMS", 100, 1, 500],
  ["maxPagesPerSource", "DISCOVERY_SOURCE_MAX_PAGES", 4, 1, 20],
  ["maxCallsPerSource", "DISCOVERY_SOURCE_MAX_CALLS", 20, 1, 100],
  [
    "maxResponseBytes",
    "DISCOVERY_RESPONSE_MAX_BYTES",
    2 * 1024 * 1024,
    64 * 1024,
    8 * 1024 * 1024,
  ],
  [
    "maxBytesPerSource",
    "DISCOVERY_SOURCE_MAX_BYTES",
    10 * 1024 * 1024,
    256 * 1024,
    32 * 1024 * 1024,
  ],
  ["maxMatchingItemsPerTick", "DISCOVERY_MATCH_MAX_ITEMS", 20, 1, 100],
  ["matchingTimeoutMs", "DISCOVERY_MATCH_TIMEOUT_MS", 45_000, 5_000, 120_000],
  ["leaseMs", "DISCOVERY_LEASE_MS", 45_000, 15_000, 300_000],
  ["heartbeatMs", "DISCOVERY_HEARTBEAT_MS", 10_000, 2_000, 60_000],
] as const satisfies ReadonlyArray<
  readonly [keyof DiscoveryOperatorPolicy, string, number, number, number]
>;

describe("discovery operator policy", () => {
  it("uses every approved default when the environment is absent", () => {
    expect(parseDiscoveryOperatorPolicy({})).toEqual(DEFAULT_DISCOVERY_POLICY);
    expect(Object.isFrozen(DEFAULT_DISCOVERY_POLICY)).toBe(true);
    for (const [field, , fallback] of cases) {
      expect(DEFAULT_DISCOVERY_POLICY[field]).toBe(fallback);
    }
  });

  it("accepts every inclusive minimum and maximum", () => {
    const minimums = Object.fromEntries(
      cases.map(([, environment, , minimum]) => [
        environment,
        String(minimum),
      ]),
    );
    const maximums = Object.fromEntries(
      cases.map(([, environment, , , maximum]) => [
        environment,
        String(maximum),
      ]),
    );

    const minimumPolicy = parseDiscoveryOperatorPolicy(minimums);
    const maximumPolicy = parseDiscoveryOperatorPolicy(maximums);
    for (const [field, , , minimum, maximum] of cases) {
      expect(minimumPolicy[field]).toBe(minimum);
      expect(maximumPolicy[field]).toBe(maximum);
    }
  });

  it.each(
    cases.flatMap(([field, environment, , minimum, maximum]) => [
      [field, environment, minimum - 1],
      [field, environment, maximum + 1],
    ]),
  )("rejects %s outside the hard range via %s=%s", (_field, environment, value) => {
    expect(() =>
      parseDiscoveryOperatorPolicy({ [environment]: String(value) }),
    ).toThrow(new RegExp(environment));
  });

  it.each(["", " ", "nope", "1.5", "1e-2", "NaN", "Infinity", "-Infinity"])(
    "rejects invalid integer syntax %j",
    (value) => {
      expect(() =>
        parseDiscoveryOperatorPolicy({
          DISCOVERY_SOURCE_MAX_ITEMS: value,
        }),
      ).toThrow(/DISCOVERY_SOURCE_MAX_ITEMS.*integer/i);
    },
  );

  it("requires source and matching work to fit strictly inside a tick", () => {
    expect(() =>
      parseDiscoveryOperatorPolicy({
        DISCOVERY_TICK_TIMEOUT_MS: "10000",
        DISCOVERY_SOURCE_TIMEOUT_MS: "10000",
      }),
    ).toThrow(/source timeout.*below.*tick/i);
    expect(() =>
      parseDiscoveryOperatorPolicy({
        DISCOVERY_TICK_TIMEOUT_MS: "10000",
        DISCOVERY_SOURCE_TIMEOUT_MS: "5000",
        DISCOVERY_MATCH_TIMEOUT_MS: "10000",
      }),
    ).toThrow(/matching timeout.*below.*tick/i);
  });

  it("requires the heartbeat period to be less than half the lease", () => {
    expect(() =>
      parseDiscoveryOperatorPolicy({
        DISCOVERY_LEASE_MS: "15000",
        DISCOVERY_HEARTBEAT_MS: "10000",
      }),
    ).toThrow(/less than half/i);
    expect(() =>
      parseDiscoveryOperatorPolicy({
        DISCOVERY_LEASE_MS: "15000",
        DISCOVERY_HEARTBEAT_MS: "7500",
      }),
    ).toThrow(/less than half/i);
  });
});
