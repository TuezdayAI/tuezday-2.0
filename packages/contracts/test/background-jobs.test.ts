import { describe, expect, it } from "vitest";
import {
  BACKGROUND_JOB_KINDS,
  backgroundJobPayloadSchema,
  backgroundJobStatusSchema,
} from "../src";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const LAUNCH_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

describe("background job contracts", () => {
  it("publishes the complete Sprint 73 job vocabulary in stable order", () => {
    expect(BACKGROUND_JOB_KINDS).toEqual([
      "discovery",
      "automation",
      "pipelines",
      "preferences",
      "learning",
      "ads",
      "cadence",
      "publish",
      "inbox",
      "mailbox_inbox",
      "outreach",
      "sequence",
      "evidence",
      "launch_generate",
    ]);
  });

  it.each(BACKGROUND_JOB_KINDS.filter((kind) => kind !== "launch_generate"))(
    "accepts the tenant-bound %s payload and rejects extra fields",
    (kind) => {
      expect(
        backgroundJobPayloadSchema.parse({ kind, workspaceId: WORKSPACE_ID }),
      ).toEqual({ kind, workspaceId: WORKSPACE_ID });
      expect(() =>
        backgroundJobPayloadSchema.parse({
          kind,
          workspaceId: WORKSPACE_ID,
          attackerControlled: true,
        }),
      ).toThrow();
    },
  );

  it("preserves launch generation input and human attribution", () => {
    expect(
      backgroundJobPayloadSchema.parse({
        kind: "launch_generate",
        workspaceId: WORKSPACE_ID,
        launchId: LAUNCH_ID,
        input: { useEvidence: true, tokenBudget: 2_000 },
        actor: { userId: USER_ID, label: "Founder", human: true },
      }),
    ).toEqual({
      kind: "launch_generate",
      workspaceId: WORKSPACE_ID,
      launchId: LAUNCH_ID,
      input: { useEvidence: true, tokenBudget: 2_000 },
      actor: { userId: USER_ID, label: "Founder", human: true },
    });
  });

  it("rejects malformed tenant ids, actor attribution, and launch input", () => {
    expect(() =>
      backgroundJobPayloadSchema.parse({
        kind: "launch_generate",
        workspaceId: "another-workspace",
        launchId: LAUNCH_ID,
        input: {},
        actor: { userId: USER_ID, label: "Founder", human: true },
      }),
    ).toThrow();
    expect(() =>
      backgroundJobPayloadSchema.parse({
        kind: "launch_generate",
        workspaceId: WORKSPACE_ID,
        launchId: LAUNCH_ID,
        input: { tokenBudget: -1 },
        actor: { userId: null, label: "system", human: true },
      }),
    ).toThrow();
  });

  it("accepts only durable queue lifecycle states", () => {
    expect(
      ["queued", "running", "succeeded", "dead_letter", "cancelled"].map(
        (status) => backgroundJobStatusSchema.parse(status),
      ),
    ).toHaveLength(5);
    expect(() => backgroundJobStatusSchema.parse("retrying")).toThrow();
  });
});
