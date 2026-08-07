import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerConfig {
  internalApiUrl: string;
  token: string;
  queuePollMs: number;
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

function queuePollMs(env: NodeJS.ProcessEnv): number {
  const name = "BACKGROUND_JOB_POLL_MS";
  const raw = env[name];
  const value = raw === undefined ? 1_000 : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error(`${name} must be a whole number from 250 through 60000.`);
  }
  return value;
}

export function parseWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const suppliedToken = env.TUEZDAY_WORKER_TOKEN?.trim();
  const token =
    suppliedToken ||
    (env.NODE_ENV === "test" ? "test-worker-token" : undefined);
  if (!token) throw new Error("TUEZDAY_WORKER_TOKEN is required.");

  return {
    internalApiUrl: internalOrigin(env),
    token,
    queuePollMs: queuePollMs(env),
  };
}
