import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_JOB_POLICY,
  parseBackgroundJobPolicy,
} from "../src/runtime/background-job-policy";

describe("background job operator policy", () => {
  it("publishes safe queue and existing scheduler defaults", () => {
    const policy = parseBackgroundJobPolicy({});
    expect(policy).toEqual(DEFAULT_BACKGROUND_JOB_POLICY);
    expect(policy.pollMs).toBe(1_000);
    expect(policy.batchSize).toBe(4);
    expect(policy.perWorkspaceConcurrency).toBe(1);
    expect(policy.leaseMs).toBe(300_000);
    expect(policy.heartbeatMs).toBe(30_000);
    expect(policy.maxAttempts).toBe(5);
    expect(policy.baseBackoffMs).toBe(5_000);
    expect(policy.maxBackoffMs).toBe(3_600_000);
    expect(policy.intervals).toEqual({
      discovery: 30 * 60_000,
      automation: 5 * 60_000,
      pipelines: 2 * 60_000,
      preferences: 10 * 60_000,
      learning: 7 * 86_400_000,
      ads: 6 * 3_600_000,
      cadence: 5 * 60_000,
      publish: 60_000,
      inbox: 5 * 60_000,
      mailbox_inbox: 5 * 60_000,
      outreach: 5 * 60_000,
      sequence: 5 * 60_000,
      evidence: 30 * 60_000,
    });
  });

  it.each([
    ["BACKGROUND_JOB_POLL_MS", "250", "60000", {}, {}],
    ["BACKGROUND_JOB_BATCH_SIZE", "1", "100", {}, {}],
    ["BACKGROUND_JOB_PER_WORKSPACE", "1", "100", {}, { BACKGROUND_JOB_BATCH_SIZE: "100" }],
    ["BACKGROUND_JOB_LEASE_MS", "15000", "3600000", { BACKGROUND_JOB_HEARTBEAT_MS: "1000" }, {}],
    ["BACKGROUND_JOB_HEARTBEAT_MS", "1000", "60000", {}, {}],
    ["BACKGROUND_JOB_MAX_ATTEMPTS", "1", "25", {}, {}],
    ["BACKGROUND_JOB_BACKOFF_MS", "100", "3600000", {}, { BACKGROUND_JOB_MAX_BACKOFF_MS: "3600000" }],
    ["BACKGROUND_JOB_MAX_BACKOFF_MS", "100", "604800000", { BACKGROUND_JOB_BACKOFF_MS: "100" }, {}],
  ] as const)(
    "accepts inclusive %s bounds",
    (name, minimum, maximum, minimumEnv, maximumEnv) => {
      expect(() =>
        parseBackgroundJobPolicy({ ...minimumEnv, [name]: minimum }),
      ).not.toThrow();
      expect(() =>
        parseBackgroundJobPolicy({ ...maximumEnv, [name]: maximum }),
      ).not.toThrow();
    },
  );

  it.each([
    "BACKGROUND_JOB_POLL_MS",
    "BACKGROUND_JOB_BATCH_SIZE",
    "BACKGROUND_JOB_PER_WORKSPACE",
    "BACKGROUND_JOB_LEASE_MS",
    "BACKGROUND_JOB_HEARTBEAT_MS",
    "BACKGROUND_JOB_MAX_ATTEMPTS",
    "BACKGROUND_JOB_BACKOFF_MS",
    "BACKGROUND_JOB_MAX_BACKOFF_MS",
    "DISCOVERY_INTERVAL_MIN",
    "PIPELINES_INTERVAL_MIN",
    "LEARNING_SYNTHESIS_DAYS",
    "ADS_SYNC_HOURS",
  ])("rejects malformed %s values", (name) => {
    for (const value of ["", "NaN", "1.5", "0", "-1"]) {
      expect(() => parseBackgroundJobPolicy({ [name]: value })).toThrow(name);
    }
  });

  it("rejects unsafe cross-field bounds", () => {
    expect(() =>
      parseBackgroundJobPolicy({
        BACKGROUND_JOB_BATCH_SIZE: "2",
        BACKGROUND_JOB_PER_WORKSPACE: "3",
      }),
    ).toThrow("BACKGROUND_JOB_PER_WORKSPACE");
    expect(() =>
      parseBackgroundJobPolicy({
        BACKGROUND_JOB_LEASE_MS: "15000",
        BACKGROUND_JOB_HEARTBEAT_MS: "8000",
      }),
    ).toThrow("BACKGROUND_JOB_HEARTBEAT_MS");
    expect(() =>
      parseBackgroundJobPolicy({
        BACKGROUND_JOB_BACKOFF_MS: "1000",
        BACKGROUND_JOB_MAX_BACKOFF_MS: "999",
      }),
    ).toThrow("BACKGROUND_JOB_MAX_BACKOFF_MS");
  });
});
