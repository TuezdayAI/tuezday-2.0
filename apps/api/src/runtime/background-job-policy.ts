import type { BackgroundRecurringJobKind } from "@tuezday/contracts";

export interface BackgroundJobPolicy {
  pollMs: number;
  batchSize: number;
  perWorkspaceConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  intervals: Record<BackgroundRecurringJobKind, number>;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw.trim());
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function duration(
  env: NodeJS.ProcessEnv,
  name: string,
  fallbackUnits: number,
  unitMs: number,
  minimumUnits: number,
  maximumUnits: number,
): number {
  const units = integer(env, name, fallbackUnits, minimumUnits, maximumUnits);
  const value = units * unitMs;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} produces an unsafe millisecond duration.`);
  }
  return value;
}

export function parseBackgroundJobPolicy(
  env: NodeJS.ProcessEnv,
): BackgroundJobPolicy {
  const policy: BackgroundJobPolicy = {
    pollMs: integer(env, "BACKGROUND_JOB_POLL_MS", 1_000, 250, 60_000),
    batchSize: integer(env, "BACKGROUND_JOB_BATCH_SIZE", 4, 1, 100),
    perWorkspaceConcurrency: integer(
      env,
      "BACKGROUND_JOB_PER_WORKSPACE",
      1,
      1,
      100,
    ),
    leaseMs: integer(
      env,
      "BACKGROUND_JOB_LEASE_MS",
      300_000,
      15_000,
      3_600_000,
    ),
    heartbeatMs: integer(
      env,
      "BACKGROUND_JOB_HEARTBEAT_MS",
      30_000,
      1_000,
      60_000,
    ),
    maxAttempts: integer(
      env,
      "BACKGROUND_JOB_MAX_ATTEMPTS",
      5,
      1,
      25,
    ),
    baseBackoffMs: integer(
      env,
      "BACKGROUND_JOB_BACKOFF_MS",
      5_000,
      100,
      3_600_000,
    ),
    maxBackoffMs: integer(
      env,
      "BACKGROUND_JOB_MAX_BACKOFF_MS",
      3_600_000,
      100,
      604_800_000,
    ),
    intervals: {
      discovery: duration(env, "DISCOVERY_INTERVAL_MIN", 30, 60_000, 1, 1_440),
      automation: duration(env, "AUTOMATION_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      pipelines: duration(env, "PIPELINES_INTERVAL_MIN", 2, 60_000, 1, 1_440),
      preferences: duration(env, "PREFERENCES_INTERVAL_MIN", 10, 60_000, 1, 1_440),
      learning: duration(env, "LEARNING_SYNTHESIS_DAYS", 7, 86_400_000, 1, 365),
      ads: duration(env, "ADS_SYNC_HOURS", 6, 3_600_000, 1, 168),
      cadence: duration(env, "CADENCE_FILL_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      publish: duration(env, "PUBLISH_INTERVAL_MIN", 1, 60_000, 1, 1_440),
      inbox: duration(env, "INBOX_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      mailbox_inbox: duration(env, "MAILBOX_INBOX_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      outreach: duration(env, "OUTREACH_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      sequence: duration(env, "SEQUENCE_INTERVAL_MIN", 5, 60_000, 1, 1_440),
      evidence: duration(env, "EVIDENCE_SWEEP_MIN", 30, 60_000, 1, 1_440),
    },
  };

  if (policy.perWorkspaceConcurrency > policy.batchSize) {
    throw new Error(
      "BACKGROUND_JOB_PER_WORKSPACE must be less than or equal to BACKGROUND_JOB_BATCH_SIZE.",
    );
  }
  if (policy.heartbeatMs * 2 >= policy.leaseMs) {
    throw new Error(
      "BACKGROUND_JOB_HEARTBEAT_MS multiplied by 2 must be below BACKGROUND_JOB_LEASE_MS.",
    );
  }
  if (policy.baseBackoffMs > policy.maxBackoffMs) {
    throw new Error(
      "BACKGROUND_JOB_MAX_BACKOFF_MS must be greater than or equal to BACKGROUND_JOB_BACKOFF_MS.",
    );
  }
  return policy;
}

export const DEFAULT_BACKGROUND_JOB_POLICY = parseBackgroundJobPolicy({});
