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
  it("captures workspace-scoped events when opted in", () => {
    const db = createTestDb();
    const ws = createWorkspace(db, { name: "Acme" });
    const { sink, calls } = recording();
    track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(1);
  });
  it("drops workspace-scoped events when opted out", () => {
    const db = createTestDb();
    const ws = createWorkspace(db, { name: "Acme" });
    setAnalyticsOptOut(db, ws.id, true);
    const { sink, calls } = recording();
    track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(0);
  });
  it("captures user-lifecycle events (no workspace) regardless", () => {
    const db = createTestDb();
    const { sink, calls } = recording();
    track(db, sink, { event: "user.registered", distinctId: "u1" });
    expect(calls).toHaveLength(1);
  });
  it("never throws if the sink throws", () => {
    const db = createTestDb();
    const sink: AnalyticsSink = { capture: () => { throw new Error("boom"); } };
    expect(() => track(db, sink, { event: "draft.approved", distinctId: "u1" })).not.toThrow();
  });
});
