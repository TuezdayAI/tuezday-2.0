import { afterEach, describe, expect, it } from "vitest";
import { NoopSink, createAnalyticsSink } from "../src/analytics/sink";
import { PostHogSink } from "../src/analytics/posthog";

afterEach(() => {
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
});

describe("PostHogSink", () => {
  it("POSTs a well-formed capture body to /capture/", async () => {
    let url: string | undefined;
    let body: any;
    const fetcher = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    new PostHogSink("phc_test", "https://eu.example.posthog.com", fetcher).capture({
      event: "generation.created",
      distinctId: "user-1",
      workspaceId: "ws-1",
      properties: { taskType: "linkedin_post", channel: "linkedin" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(url).toBe("https://eu.example.posthog.com/capture/");
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "generation.created",
      distinct_id: "user-1",
      properties: { taskType: "linkedin_post", channel: "linkedin", $groups: { workspace: "ws-1" } },
    });
  });

  it("never throws when the network fails", async () => {
    const fetcher = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const sink = new PostHogSink("phc_test", undefined, fetcher);
    expect(() => sink.capture({ event: "draft.approved", distinctId: "u" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("createAnalyticsSink", () => {
  it("returns Noop when no key is set", () => {
    expect(createAnalyticsSink()).toBeInstanceOf(NoopSink);
  });
  it("returns PostHogSink when a key is set", () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    expect(createAnalyticsSink()).toBeInstanceOf(PostHogSink);
  });
});
