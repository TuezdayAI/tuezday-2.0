import { describe, expect, it } from "vitest";
import type { DiscoverySource } from "@tuezday/contracts";
import {
  checkpointPage,
  readCursor,
  reconcileTargets,
  resolveDiscoveryTargets,
  safeCursorProgress,
} from "../src/discovery/paging";

function source(
  config: DiscoverySource["config"],
  type: DiscoverySource["type"] = "x",
): DiscoverySource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    type,
    name: "Source",
    config,
    enabled: true,
    status: "active",
    lastError: null,
    lastFetchedAt: null,
    connectionId: "33333333-3333-4333-8333-333333333333",
    cursor: {
      version: 1,
      targetCount: 0,
      backlog: false,
      lastCheckpointAt: null,
    },
    backoffUntil: null,
    lastAttemptedAt: null,
    createdAt: 1,
  };
}

const tracked = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    handle: "Competitor",
    externalId: "provider-1",
    enabled: true,
    updatedAt: 10,
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    handle: "Other",
    externalId: null,
    enabled: true,
    updatedAt: 20,
  },
];

describe("discovery cursor model", () => {
  it("uses tracked UUIDs as stable keys and hashes normalized inline targets", () => {
    const targets = resolveDiscoveryTargets({
      source: source({
        mode: "account_timeline",
        handles: [" @INLINE ", "inline"],
        trackedAccountIds: tracked.map((account) => account.id),
      }),
      trackedAccounts: tracked,
    });

    expect(targets.map((target) => target.key)).toEqual([
      `tracked:${tracked[0]!.id}`,
      `tracked:${tracked[1]!.id}`,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("preserves unrelated checkpoints when one tracked target changes", () => {
    const originalTargets = resolveDiscoveryTargets({
      source: source({
        mode: "account_timeline",
        trackedAccountIds: tracked.map((account) => account.id),
      }),
      trackedAccounts: tracked,
    });
    let cursor = reconcileTargets(
      readCursor("{}", "account_timeline"),
      originalTargets,
    );
    cursor.targets[originalTargets[0]!.key]!.highWatermark = {
      externalId: "a",
      publishedAt: 1,
    };
    cursor.targets[originalTargets[1]!.key]!.highWatermark = {
      externalId: "b",
      publishedAt: 2,
    };
    const changedTargets = resolveDiscoveryTargets({
      source: source({
        mode: "account_timeline",
        trackedAccountIds: tracked.map((account) => account.id),
      }),
      trackedAccounts: [
        { ...tracked[0]!, handle: "renamed", updatedAt: 11 },
        tracked[1]!,
      ],
    });

    cursor = reconcileTargets(cursor, changedTargets);

    expect(cursor.targets[changedTargets[0]!.key]!.highWatermark).toBeNull();
    expect(cursor.targets[changedTargets[1]!.key]!.highWatermark?.externalId)
      .toBe("b");
  });

  it("keeps an independent continuation and survives round-robin restart", () => {
    const targets = resolveDiscoveryTargets({
      source: source({
        mode: "account_timeline",
        trackedAccountIds: tracked.map((account) => account.id),
      }),
      trackedAccounts: tracked,
    });
    const cursor = reconcileTargets(
      readCursor("{}", "account_timeline"),
      targets,
    );
    const checkpointed = checkpointPage({
      cursor,
      target: targets[0]!,
      page: {
        targetKey: targets[0]!.key,
        items: [
          {
            externalId: "newest",
            title: "Newest",
            url: "",
            summary: "",
            publishedAt: 5,
          },
        ],
        nextToken: "secret-token",
        reachedBoundary: false,
        exhausted: false,
        callsUsed: 1,
        decodedBytes: 10,
      },
      nextTargetIndex: 1,
    });
    const restarted = readCursor(
      JSON.stringify(checkpointed),
      "account_timeline",
    );

    expect(restarted.nextTargetIndex).toBe(1);
    expect(
      restarted.targets[targets[0]!.key]!.continuation?.providerToken,
    ).toBe("secret-token");
    expect(restarted.targets[targets[1]!.key]!.continuation).toBeNull();
    expect(JSON.stringify(safeCursorProgress(restarted, 100)))
      .not.toContain("secret-token");
  });

  it("promotes the newest item only after provider end or old boundary", () => {
    const [target] = resolveDiscoveryTargets({
      source: source({ mode: "query", query: "founder" }),
      trackedAccounts: [],
    });
    const cursor = reconcileTargets(
      readCursor("{}", "query"),
      [target!],
    );
    cursor.targets[target!.key]!.highWatermark = {
      externalId: "old",
      publishedAt: 1,
    };
    const draining = checkpointPage({
      cursor,
      target: target!,
      page: {
        targetKey: target!.key,
        items: [
          {
            externalId: "new",
            title: "New",
            url: "",
            summary: "",
            publishedAt: 2,
          },
        ],
        nextToken: "page-2",
        reachedBoundary: false,
        exhausted: false,
        callsUsed: 1,
        decodedBytes: 1,
      },
      nextTargetIndex: 0,
    });
    expect(draining.targets[target!.key]!.highWatermark?.externalId)
      .toBe("old");
    const completed = checkpointPage({
      cursor: draining,
      target: target!,
      page: {
        targetKey: target!.key,
        items: [],
        nextToken: null,
        reachedBoundary: true,
        exhausted: true,
        callsUsed: 1,
        decodedBytes: 1,
      },
      nextTargetIndex: 0,
    });
    expect(completed.targets[target!.key]!.highWatermark?.externalId)
      .toBe("new");
    expect(completed.targets[target!.key]!.continuation).toBeNull();
  });
});
