import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_JOB_KINDS, type BackgroundJobKind } from "@tuezday/contracts";
import {
  defineBackgroundJobHandlers,
  unavailableBackgroundJobHandlers,
  type BackgroundJobHandler,
  type BackgroundJobHandlers,
} from "../src/services/background-job-handlers";

function handler(): BackgroundJobHandler {
  return vi.fn(async () => ({ status: "complete" as const }));
}

describe("background job handler registry", () => {
  it("requires exactly one handler for every public job kind", () => {
    const handlers = Object.fromEntries(
      BACKGROUND_JOB_KINDS.map((kind) => [kind, handler()]),
    ) as BackgroundJobHandlers;
    expect(defineBackgroundJobHandlers(handlers)).toBe(handlers);

    const missing = { ...handlers } as Record<string, BackgroundJobHandler>;
    delete missing.evidence;
    expect(() =>
      defineBackgroundJobHandlers(missing as BackgroundJobHandlers),
    ).toThrow("Missing background job handler: evidence");

    expect(() =>
      defineBackgroundJobHandlers({
        ...handlers,
        invented: handler(),
      } as BackgroundJobHandlers & Record<"invented", BackgroundJobHandler>),
    ).toThrow("Unknown background job handler: invented");
  });

  it("fails closed when domain handlers have not been wired", async () => {
    const handlers = unavailableBackgroundJobHandlers();
    for (const kind of BACKGROUND_JOB_KINDS) {
      await expect(
        await handlers[kind](
          kind === "launch_generate"
            ? {
                kind,
                workspaceId: "11111111-1111-4111-8111-111111111111",
                launchId: "22222222-2222-4222-8222-222222222222",
                input: {},
                actor: { userId: null, label: "system", human: false },
              }
            : {
                kind: kind as Exclude<BackgroundJobKind, "launch_generate">,
                workspaceId: "11111111-1111-4111-8111-111111111111",
              },
          expect.anything(),
        ),
      ).resolves.toEqual({
        status: "retry",
        error: `background_job_handler_unavailable:${kind}`,
      });
    }
  });
});
