import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerConfig {
  internalApiUrl: string;
  token: string;
  intervals: {
    discoveryMs: number;
    automationMs: number;
    pipelinesMs: number;
    preferencesMs: number;
    learningMs: number;
    adsMs: number;
    publishMs: number;
    cadenceMs: number;
    inboxMs: number;
    mailboxInboxMs: number;
    outreachMs: number;
    sequenceMs: number;
    evidenceMs: number;
  };
}

const DEFAULT_ROOT_ENV = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);

export function loadRootEnv(path = DEFAULT_ROOT_ENV): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match || match[2] === "" || match[1]!.startsWith("#")) continue;
    const name = match[1]!;
    if (process.env[name] !== undefined) continue;
    process.env[name] = match[2]!.replace(/^(['"])(.*)\1$/s, "$2");
  }
}

function internalOrigin(env: NodeJS.ProcessEnv): string {
  const raw =
    env.TUEZDAY_INTERNAL_API_URL?.trim() || "http://localhost:3001";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "TUEZDAY_INTERNAL_API_URL must be an absolute HTTP(S) origin.",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "TUEZDAY_INTERNAL_API_URL must use HTTPS, except loopback HTTP for development, and contain only an origin.",
    );
  }
  return parsed.origin;
}

function duration(
  env: NodeJS.ProcessEnv,
  name: string,
  fallbackUnits: number,
  unitMs: number,
  minimumMs: number,
  maximumMs: number,
): number {
  const raw = env[name];
  const units = raw === undefined ? fallbackUnits : Number(raw.trim());
  const value = units * unitMs;
  if (
    !Number.isSafeInteger(units) ||
    !Number.isSafeInteger(value) ||
    value < minimumMs ||
    value > maximumMs
  ) {
    throw new Error(
      `${name} must be a whole number producing ${minimumMs} through ${maximumMs} milliseconds.`,
    );
  }
  return value;
}

export function parseWorkerConfig(
  env: NodeJS.ProcessEnv,
): WorkerConfig {
  const suppliedToken = env.TUEZDAY_WORKER_TOKEN?.trim();
  const token =
    suppliedToken ||
    (env.NODE_ENV === "test" ? "test-worker-token" : undefined);
  if (!token) {
    throw new Error("TUEZDAY_WORKER_TOKEN is required.");
  }

  return {
    internalApiUrl: internalOrigin(env),
    token,
    intervals: {
      discoveryMs: duration(
        env,
        "DISCOVERY_INTERVAL_MIN",
        30,
        60_000,
        60_000,
        86_400_000,
      ),
      automationMs: duration(
        env,
        "AUTOMATION_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      // Sprint 65: executes queued pipeline runs (live + shadow). Faster than
      // automation so a queued run rests before the next automation pass.
      pipelinesMs: duration(
        env,
        "PIPELINES_INTERVAL_MIN",
        2,
        60_000,
        60_000,
        86_400_000,
      ),
      // Sprint 68: extracts learned preference rules from captured founder
      // edits. Ten minutes is the "learns inside a day, not inside a week"
      // requirement met with room to spare — the LLM cost is one small call
      // per scope group, and only when there is a backlog to digest.
      preferencesMs: duration(
        env,
        "PREFERENCES_INTERVAL_MIN",
        10,
        60_000,
        60_000,
        86_400_000,
      ),
      learningMs: duration(
        env,
        "LEARNING_SYNTHESIS_DAYS",
        7,
        86_400_000,
        86_400_000,
        31_536_000_000,
      ),
      adsMs: duration(
        env,
        "ADS_SYNC_HOURS",
        6,
        3_600_000,
        3_600_000,
        604_800_000,
      ),
      publishMs: duration(
        env,
        "PUBLISH_INTERVAL_MIN",
        1,
        60_000,
        60_000,
        86_400_000,
      ),
      cadenceMs: duration(
        env,
        "CADENCE_FILL_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      inboxMs: duration(
        env,
        "INBOX_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      mailboxInboxMs: duration(
        env,
        "MAILBOX_INBOX_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      outreachMs: duration(
        env,
        "OUTREACH_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      sequenceMs: duration(
        env,
        "SEQUENCE_INTERVAL_MIN",
        5,
        60_000,
        60_000,
        86_400_000,
      ),
      evidenceMs: duration(
        env,
        "EVIDENCE_SWEEP_MIN",
        30,
        60_000,
        60_000,
        86_400_000,
      ),
    },
  };
}
