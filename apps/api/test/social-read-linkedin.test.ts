import { describe, expect, it } from "vitest";
import { ConnectorFabricError, type ConnectorFabric } from "../src/connectors/fabric";
import { LinkedInAdapter } from "../src/connectors/social/linkedin";

// ---------------------------------------------------------------------------
// Fake fabric (pattern from publish.test.ts): only proxyJson is exercised by
// the adapter, so the rest of the interface is stubbed via the cast.
// ---------------------------------------------------------------------------

interface CannedResponse {
  status: number;
  json: unknown;
}

interface FakeState {
  userinfo: CannedResponse;
  posts: CannedResponse;
}

interface RecordedProxyCall {
  method: string;
  path: string;
  opts?: { headers?: Record<string, string>; baseUrlOverride?: string };
}

function adapterFor(state: FakeState, calls: RecordedProxyCall[] = []): LinkedInAdapter {
  const fabric = {
    async proxyJson(
      method: "GET" | "POST",
      path: string,
      _c: string,
      _k: string,
      opts?: RecordedProxyCall["opts"],
    ) {
      calls.push({ method, path, opts });
      if (path === "/v2/userinfo") return state.userinfo;
      if (path.startsWith("/rest/posts")) return state.posts;
      return { status: 404, json: { message: "no such endpoint" } };
    },
  } as unknown as ConnectorFabric;
  return new LinkedInAdapter(fabric, { nangoConnectionId: "c", integrationKey: "tuezday-linkedin" });
}

const userinfoOk: CannedResponse = {
  status: 200,
  json: { sub: "abc123", name: "Jane Doe", given_name: "Jane", family_name: "Doe" },
};

// ---------------------------------------------------------------------------
// readSocialProfile
// ---------------------------------------------------------------------------

describe("LinkedInAdapter.readSocialProfile", () => {
  it("normalizes profile fields and recent posts", async () => {
    const calls: RecordedProxyCall[] = [];
    const adapter = adapterFor(
      {
        userinfo: userinfoOk,
        posts: {
          status: 200,
          json: {
            elements: [
              {
                id: "urn:li:share:111",
                commentary: "First post",
                createdAt: 1700000000000,
              },
              {
                id: "urn:li:share:222",
                commentary: "Second post",
                publishedAt: 1690000000000,
              },
            ],
          },
        },
      },
      calls,
    );

    const profile = await adapter.readSocialProfile();

    expect(profile.displayName).toBe("Jane Doe");
    expect(profile.handle).toBe("jane-doe");
    expect(profile.bio).toBe("");
    expect(profile.recentPosts).toEqual([
      {
        text: "First post",
        url: "https://www.linkedin.com/feed/update/urn:li:share:111",
        createdAt: 1700000000000,
      },
      {
        text: "Second post",
        url: "https://www.linkedin.com/feed/update/urn:li:share:222",
        createdAt: 1690000000000,
      },
    ]);

    // Posts fetched via the versioned REST API, author URN encoded.
    const postsCall = calls.find((c) => c.path.startsWith("/rest/posts"));
    expect(postsCall).toBeDefined();
    expect(postsCall!.method).toBe("GET");
    expect(postsCall!.path).toContain(`author=${encodeURIComponent("urn:li:person:abc123")}`);
    expect(postsCall!.path).toContain("q=author");
    expect(postsCall!.opts?.headers?.["LinkedIn-Version"]).toBeDefined();
  });

  it("caps recent posts at 25", async () => {
    const elements = Array.from({ length: 30 }, (_, i) => ({
      id: `urn:li:share:${i}`,
      commentary: `Post ${i}`,
      createdAt: 1700000000000 + i,
    }));
    const adapter = adapterFor({ userinfo: userinfoOk, posts: { status: 200, json: { elements } } });

    const profile = await adapter.readSocialProfile();

    expect(profile.recentPosts).toHaveLength(25);
    expect(profile.recentPosts[0]!.text).toBe("Post 0");
    expect(profile.recentPosts[24]!.text).toBe("Post 24");
  });

  it("defaults missing fields (post text/url/createdAt, profile name/handle)", async () => {
    const adapter = adapterFor({
      userinfo: { status: 200, json: { sub: "abc123" } },
      posts: { status: 200, json: { elements: [{}] } },
    });

    const profile = await adapter.readSocialProfile();

    expect(profile.displayName).toBe("");
    expect(profile.handle).toBe("");
    expect(profile.bio).toBe("");
    expect(profile.recentPosts).toEqual([{ text: "", url: "", createdAt: null }]);
  });

  it("handles a posts response with no elements", async () => {
    const adapter = adapterFor({ userinfo: userinfoOk, posts: { status: 200, json: {} } });

    const profile = await adapter.readSocialProfile();

    expect(profile.recentPosts).toEqual([]);
  });

  it("throws ConnectorFabricError on a non-2xx posts response", async () => {
    const adapter = adapterFor({
      userinfo: userinfoOk,
      posts: { status: 403, json: { message: "not permitted" } },
    });

    await expect(adapter.readSocialProfile()).rejects.toThrow(ConnectorFabricError);
    await expect(adapter.readSocialProfile()).rejects.toThrow(/403/);
  });

  it("throws ConnectorFabricError on a non-2xx userinfo response", async () => {
    const adapter = adapterFor({
      userinfo: { status: 401, json: { message: "expired" } },
      posts: { status: 200, json: { elements: [] } },
    });

    await expect(adapter.readSocialProfile()).rejects.toThrow(ConnectorFabricError);
    await expect(adapter.readSocialProfile()).rejects.toThrow(/401/);
  });
});
