import { describe, expect, it } from "vitest";
import { track } from "../src/analytics/track";
import type { AnalyticsSink, AnalyticsEventInput } from "../src/analytics/sink";
import { createWorkspace, setAnalyticsOptOut } from "../src/services/workspaces";
import { createTestDb } from "./helpers";

function recording() {
  const calls: AnalyticsEventInput[] = [];
  const sink: AnalyticsSink = { capture: (i) => calls.push(i) };
  return { sink, calls };
}

describe("track()", () => {
  it("captures workspace-scoped events when opted in", async () => {
    const db = createTestDb();
    const ws = await createWorkspace(db, { name: "Acme" });
    const { sink, calls } = recording();
    await track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(1);
  });
  it("drops workspace-scoped events when opted out", async () => {
    const db = createTestDb();
    const ws = await createWorkspace(db, { name: "Acme" });
    await setAnalyticsOptOut(db, ws.id, true);
    const { sink, calls } = recording();
    await track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(0);
  });
  it("captures user-lifecycle events (no workspace) regardless", async () => {
    const db = createTestDb();
    const { sink, calls } = recording();
    await track(db, sink, { event: "user.registered", distinctId: "u1" });
    expect(calls).toHaveLength(1);
  });
  it("never throws if the sink throws", () => {
    const db = createTestDb();
    const sink: AnalyticsSink = { capture: () => { throw new Error("boom"); } };
    expect(async () => await track(db, sink, { event: "draft.approved", distinctId: "u1" })).not.toThrow();
  });
});
