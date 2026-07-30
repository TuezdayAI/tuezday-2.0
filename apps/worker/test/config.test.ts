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

const intervalCases = [
  ["discoveryMs", "DISCOVERY_INTERVAL_MIN", 1, 1_440, 1_800_000],
  ["automationMs", "AUTOMATION_INTERVAL_MIN", 1, 1_440, 300_000],
  ["learningMs", "LEARNING_SYNTHESIS_DAYS", 1, 365, 604_800_000],
  ["adsMs", "ADS_SYNC_HOURS", 1, 168, 21_600_000],
  ["publishMs", "PUBLISH_INTERVAL_MIN", 1, 1_440, 60_000],
  ["cadenceMs", "CADENCE_FILL_INTERVAL_MIN", 1, 1_440, 300_000],
  ["inboxMs", "INBOX_INTERVAL_MIN", 1, 1_440, 300_000],
  ["mailboxInboxMs", "MAILBOX_INBOX_INTERVAL_MIN", 1, 1_440, 300_000],
  ["outreachMs", "OUTREACH_INTERVAL_MIN", 1, 1_440, 300_000],
  ["sequenceMs", "SEQUENCE_INTERVAL_MIN", 1, 1_440, 300_000],
  ["evidenceMs", "EVIDENCE_SWEEP_MIN", 1, 1_440, 1_800_000],
] as const;

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
  it("uses the internal origin and exact interval defaults", () => {
    const config = parseWorkerConfig(BASE_ENV);

    expect(config.internalApiUrl).toBe("http://localhost:3001");
    expect(config.token).toBe(BASE_ENV.TUEZDAY_WORKER_TOKEN);
    expect(config.intervals).toEqual(
      Object.fromEntries(
        intervalCases.map(([field, , , , fallback]) => [field, fallback]),
      ),
    );
    expect(config.intervals).toMatchObject({
      discoveryMs: 30 * 60_000,
      automationMs: 5 * 60_000,
      learningMs: 7 * 86_400_000,
      adsMs: 6 * 3_600_000,
      publishMs: 60_000,
      cadenceMs: 5 * 60_000,
      inboxMs: 5 * 60_000,
      mailboxInboxMs: 5 * 60_000,
      outreachMs: 5 * 60_000,
      sequenceMs: 5 * 60_000,
      evidenceMs: 30 * 60_000,
    });
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

  it.each(intervalCases)(
    "parses inclusive boundaries for %s",
    (field, envName, minimum, maximum) => {
      const atMinimum = parseWorkerConfig({
        ...BASE_ENV,
        [envName]: String(minimum),
      });
      const atMaximum = parseWorkerConfig({
        ...BASE_ENV,
        [envName]: String(maximum),
      });
      expect(atMinimum.intervals[field]).toBeGreaterThan(0);
      expect(atMaximum.intervals[field]).toBeGreaterThan(
        atMinimum.intervals[field],
      );
    },
  );

  it.each(intervalCases)(
    "rejects malformed and out-of-range values for %s",
    (_field, envName, minimum, maximum) => {
      for (const value of [
        "NaN",
        "1.5",
        "0",
        "-1",
        String(minimum - 1),
        String(maximum + 1),
      ]) {
        expect(() =>
          parseWorkerConfig({
            ...BASE_ENV,
            [envName]: value,
          }),
        ).toThrow(envName);
      }
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
