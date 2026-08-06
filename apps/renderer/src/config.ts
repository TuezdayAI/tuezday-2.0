import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RendererConfig {
  port: number;
  token: string;
  maxConcurrency: number;
  timeoutMs: number;
}

const DEFAULT_ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

export function loadRootEnv(path = DEFAULT_ROOT_ENV): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match || match[2] === "" || match[1]!.startsWith("#")) continue;
    const name = match[1]!;
    if (process.env[name] !== undefined) continue;
    process.env[name] = match[2]!.replace(/^(['"])(.*)\1$/s, "$2");
  }
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function parseRendererConfig(env: NodeJS.ProcessEnv = process.env): RendererConfig {
  const suppliedToken = env.TUEZDAY_RENDERER_TOKEN?.trim();
  const token = suppliedToken || (env.NODE_ENV === "test" ? "test-renderer-token" : undefined);
  if (!token) throw new Error("TUEZDAY_RENDERER_TOKEN is required.");

  return {
    port: boundedInteger(env, "PORT", 7_457, 1, 65_535),
    token,
    maxConcurrency: boundedInteger(env, "RENDER_MAX_CONCURRENCY", 2, 1, 32),
    timeoutMs: boundedInteger(env, "RENDER_TIMEOUT_MS", 15_000, 1_000, 120_000),
  };
}
