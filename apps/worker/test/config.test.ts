import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRootEnv,
  parseWorkerConfig,
} from "../src/config";

const BASE_ENV = {
  TUEZDAY_WORKER_TOKEN: "worker-config-test-token",
};

const touchedEnv = new Map<string, string | undefined>();

function rememberEnv(name: string) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
}

afterEach(() => {
  for (const [name, value] of touchedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touchedEnv.clear();
});

describe("worker configuration", () => {
  it("uses only the internal origin, credential, and queue poll interval", () => {
    const config = parseWorkerConfig(BASE_ENV);

    expect(config).toEqual({
      internalApiUrl: "http://localhost:3001",
      token: BASE_ENV.TUEZDAY_WORKER_TOKEN,
      queuePollMs: 1_000,
    });
    expect(config).not.toHaveProperty("intervals");
  });

  it("never reads the browser-facing API origin", () => {
    const config = parseWorkerConfig({
      ...BASE_ENV,
      TUEZDAY_API_URL: "https://public.example.test",
    });
    expect(config.internalApiUrl).toBe("http://localhost:3001");
  });

  it.each([
    "http://api.example.test",
    "ftp://api.example.test",
    "/relative",
    "not a url",
  ])("rejects unsafe or non-absolute internal URL %s", (url) => {
    expect(() =>
      parseWorkerConfig({
        ...BASE_ENV,
        TUEZDAY_INTERNAL_API_URL: url,
      }),
    ).toThrow("TUEZDAY_INTERNAL_API_URL");
  });

  it.each([
    "http://localhost:3001/",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
    "https://api.internal.example.test/",
  ])("accepts HTTPS and loopback HTTP origin %s", (url) => {
    expect(
      parseWorkerConfig({
        ...BASE_ENV,
        TUEZDAY_INTERNAL_API_URL: url,
      }).internalApiUrl,
    ).toBe(url.replace(/\/$/, ""));
  });

  it("requires a token outside tests", () => {
    expect(() => parseWorkerConfig({})).toThrow(
      "TUEZDAY_WORKER_TOKEN is required",
    );
  });

  it("parses inclusive queue-poll bounds", () => {
    expect(
      parseWorkerConfig({
        ...BASE_ENV,
        BACKGROUND_JOB_POLL_MS: "250",
      }).queuePollMs,
    ).toBe(250);
    expect(
      parseWorkerConfig({
        ...BASE_ENV,
        BACKGROUND_JOB_POLL_MS: "60000",
      }).queuePollMs,
    ).toBe(60_000);
  });

  it.each(["NaN", "1.5", "0", "249", "60001"])(
    "rejects malformed queue poll value %s",
    (value) => {
      expect(() =>
        parseWorkerConfig({
          ...BASE_ENV,
          BACKGROUND_JOB_POLL_MS: value,
        }),
      ).toThrow("BACKGROUND_JOB_POLL_MS");
    },
  );

  it("loads root-style env files without overriding process values", () => {
    const directory = mkdtempSync(join(tmpdir(), "tuezday-worker-env-"));
    const path = join(directory, ".env");
    writeFileSync(
      path,
      [
        "# comment",
        "",
        "TUEZDAY_WORKER_TOKEN=from-file",
        "TUEZDAY_INTERNAL_API_URL='https://internal.example.test'",
      ].join("\n"),
    );
    rememberEnv("TUEZDAY_WORKER_TOKEN");
    rememberEnv("TUEZDAY_INTERNAL_API_URL");
    process.env.TUEZDAY_WORKER_TOKEN = "already-set";
    delete process.env.TUEZDAY_INTERNAL_API_URL;

    loadRootEnv(path);

    expect(process.env.TUEZDAY_WORKER_TOKEN).toBe("already-set");
    expect(process.env.TUEZDAY_INTERNAL_API_URL).toBe(
      "https://internal.example.test",
    );
    rmSync(directory, { recursive: true, force: true });
  });
});
