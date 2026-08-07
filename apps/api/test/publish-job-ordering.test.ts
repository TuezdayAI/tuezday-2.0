import { describe, expect, it, vi } from "vitest";

/**
 * Sprint 75 guaranteed that governed external actions are dispatched before
 * legacy publication receipts are settled. Sprint 73 moved that ordering out of
 * the worker's HTTP client and into the `publish` background job, so the
 * guarantee is asserted here, at its new home.
 */
const runDuePublications = vi.fn(async () => [{ id: "publication-2", ok: true }]);
vi.mock("../src/services/publications", () => ({
  runDuePublications: (...args: unknown[]) => runDuePublications(...(args as [])),
}));

const { createBackgroundJobHandlers } = await import(
  "../src/services/background-job-handlers"
);

describe("publish background job", () => {
  it("runs governed actions before legacy publication receipts", async () => {
    const calls: string[] = [];
    runDuePublications.mockImplementation(async () => {
      calls.push("publications");
      return [{ id: "publication-2", ok: true }];
    });

    const runtime = {
      run: vi.fn(async () => {
        calls.push("actions");
        return [{ action: { id: "action-1" }, execution: { id: "publication-1" } }];
      }),
    };

    const handlers = createBackgroundJobHandlers({
      runtime,
      db: {},
      fabric: {},
      fetcher: globalThis.fetch,
    } as never);

    const result = await handlers.publish(
      { kind: "publish", workspaceId: "11111111-1111-4111-8111-111111111111" },
      {} as never,
    );

    expect(calls).toEqual(["actions", "publications"]);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "complete",
      result: {
        actions: [{ action: { id: "action-1" } }],
        results: [{ id: "publication-2", ok: true }],
      },
    });
  });
});
