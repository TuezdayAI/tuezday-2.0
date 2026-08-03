import { describe, expect, it } from "vitest";
import {
  METRIC_KEYS,
  METRIC_SOURCES,
  METRIC_SUBJECT_TYPES,
  METRIC_WINDOWS,
  metricSchema,
  metricWindowKind,
} from "../src/index";

// Sprint 55: the unified metric vocabulary. These lists are deliberately closed —
// a new metric source is one writer, never a new schema, and never a new ad-hoc key.
describe("metric vocabulary", () => {
  it("defines the metric keys once, without replies", () => {
    expect(METRIC_KEYS).toEqual([
      "impressions",
      "clicks",
      "likes",
      "comments",
      "shares",
      "engagements",
      "conversions",
      "spend",
    ]);
    // `replies` is derivable from inboxItems at any moment (insights.ts,
    // outreach-funnel.ts) — storing it as a fact would create a snapshot that
    // silently goes stale. Spec §2.2 records the reasoning.
    expect(METRIC_KEYS).not.toContain("replies");
  });

  it("defines the windows, subject types, and sources once", () => {
    expect(METRIC_WINDOWS).toEqual(["point", "24h", "7d", "1d"]);
    // No lane/sequence: nothing writes them. Subject-less manual rows use channel.
    expect(METRIC_SUBJECT_TYPES).toEqual(["publication", "campaign", "ad_campaign", "channel"]);
    // No `derived`: nothing derives in Sprint 55. `imported` covers the ads CSV path.
    expect(METRIC_SOURCES).toEqual(["manual", "captured", "synced", "imported"]);
  });
});

// The load-bearing guard (spec §2.3): cumulative and periodic values must never
// be summed together. This classifier is how a reader avoids doing it by accident.
describe("metricWindowKind", () => {
  it("classifies every window", () => {
    expect(metricWindowKind("24h")).toBe("cumulative");
    expect(metricWindowKind("7d")).toBe("cumulative");
    expect(metricWindowKind("1d")).toBe("periodic");
    expect(metricWindowKind("point")).toBe("point");
  });

  it("refuses unknown windows rather than guessing", () => {
    expect(() => metricWindowKind("30d" as never)).toThrow();
    expect(() => metricWindowKind("" as never)).toThrow();
  });
});

describe("metricSchema", () => {
  const valid = {
    id: "9c5b94b1-35ad-49bb-b118-8e8fc24abf80",
    workspaceId: "9c5b94b1-35ad-49bb-b118-8e8fc24abf81",
    subjectType: "publication",
    subjectId: "9c5b94b1-35ad-49bb-b118-8e8fc24abf82",
    metricKey: "impressions",
    value: 1200,
    window: "24h",
    periodStart: 1754_000_000_000,
    source: "captured",
    capturedAt: 1754_086_400_000,
    createdAt: 1754_086_400_000,
  };

  it("accepts a well-formed row", () => {
    expect(metricSchema.parse(valid)).toMatchObject({ metricKey: "impressions" });
  });

  it("rejects vocabulary violations and non-integer values", () => {
    expect(metricSchema.safeParse({ ...valid, metricKey: "replies" }).success).toBe(false);
    expect(metricSchema.safeParse({ ...valid, window: "30d" }).success).toBe(false);
    expect(metricSchema.safeParse({ ...valid, subjectType: "lane" }).success).toBe(false);
    expect(metricSchema.safeParse({ ...valid, source: "derived" }).success).toBe(false);
    // Money is integer cents; no floats in the DB.
    expect(metricSchema.safeParse({ ...valid, value: 12.5 }).success).toBe(false);
  });
});
