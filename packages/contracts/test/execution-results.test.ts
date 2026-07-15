import { describe, expect, it } from "vitest";
import {
  EXECUTION_RESULT_KINDS,
  EXECUTION_RESULT_STATUSES,
  executionResultSchema,
} from "../src/index";

const base = {
  kind: "publication",
  id: "0b9f6b7e-1111-4c58-9d2a-9a4a5b6c7d8e",
  title: "Launch week teaser",
  channel: "linkedin",
  campaignId: null,
  campaignName: null,
  status: "completed",
  at: 1_780_000_000_000,
  url: "https://linkedin.com/feed/update/1",
  error: null,
  platformStatus: null,
  destinations: { total: 1, succeeded: 1, failed: 0, skipped: 0, pending: 0 },
  draftId: null,
  externalActionIds: [],
};

describe("unified execution result contracts", () => {
  it("defines the registry's result kinds and states verbatim", () => {
    expect(EXECUTION_RESULT_KINDS).toEqual([
      "publication",
      "launch",
      "ad_launch",
      "ad_mutation",
      "email_delivery",
    ]);
    expect(EXECUTION_RESULT_STATUSES).toEqual([
      "running",
      "completed",
      "partially_failed",
      "failed",
    ]);
  });

  it("accepts a completed publication result", () => {
    expect(executionResultSchema.parse(base)).toEqual(base);
  });

  it("carries one or many governing external action ids", () => {
    const actionId = "19a8af74-7ae8-4fef-98b5-9a8c285af662";
    expect(
      executionResultSchema.parse({ ...base, externalActionIds: [actionId] }).externalActionIds,
    ).toEqual([actionId]);
  });

  it("accepts a partially failed launch with per-destination counts", () => {
    const launch = {
      ...base,
      kind: "launch",
      channel: "email, x",
      status: "partially_failed",
      url: null,
      error: "2 recipients bounced",
      destinations: { total: 6, succeeded: 3, failed: 2, skipped: 1, pending: 0 },
    };
    expect(executionResultSchema.parse(launch).destinations.failed).toBe(2);
  });

  it("accepts a governed email delivery result", () => {
    expect(
      executionResultSchema.parse({
        ...base,
        kind: "email_delivery",
        channel: "email",
        status: "running",
      }).kind,
    ).toBe("email_delivery");
  });

  it("binds ad-mutation results to budget or targeting action kinds", () => {
    expect(
      executionResultSchema.parse({
        ...base,
        kind: "ad_mutation",
        actionKind: "budget_change",
      }).actionKind,
    ).toBe("budget_change");
    expect(
      executionResultSchema.safeParse({
        ...base,
        kind: "ad_mutation",
        actionKind: "publish",
      }).success,
    ).toBe(false);
    expect(
      executionResultSchema.safeParse({ ...base, actionKind: "targeting_change" }).success,
    ).toBe(false);
  });

  it("rejects statuses outside the canonical result vocabulary", () => {
    expect(executionResultSchema.safeParse({ ...base, status: "scheduled" }).success).toBe(false);
    expect(executionResultSchema.safeParse({ ...base, kind: "external_action" }).success).toBe(
      false,
    );
  });
});
