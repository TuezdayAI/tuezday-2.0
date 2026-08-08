import { describe, expect, it } from "vitest";
import {
  ConnectorFabricError,
  type ConnectorFabric,
  type ProxyJsonResult,
} from "../src/connectors/fabric";
import { XAdapter } from "../src/connectors/social/x";

// ---------------------------------------------------------------------------
// Fake fabric with a canned X v2 API behind the proxy (profile-read only)
// ---------------------------------------------------------------------------

interface XReadState {
  /** Response for GET /2/users/me. */
  me: ProxyJsonResult;
  /** Response for GET /2/users/{id}/tweets. */
  tweets: ProxyJsonResult;
  calls: Array<{ method: string; path: string }>;
}

function xReadState(): XReadState {
  return {
    me: {
      status: 200,
      json: {
        data: {
          id: "111",
          username: "tuezday_founder",
          name: "Tuezday Founder",
          description: "GTM orchestration, brain-first.",
        },
      },
    },
    tweets: {
      status: 200,
      json: {
        data: [
          { id: "t1", text: "First post", created_at: "2026-06-01T10:00:00.000Z" },
          { id: "t2", text: "Second post", created_at: "not-a-date" },
          { id: "t3", text: "Third post" },
        ],
      },
    },
    calls: [],
  };
}

function fakeFabric(state: XReadState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "session-token" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path) {
      state.calls.push({ method, path });
      const p = path.split("?")[0]!;
      if (p === "/2/users/me") return state.me;
      if (/^\/2\/users\/[^/]+\/tweets$/.test(p)) return state.tweets;
      return { status: 404, json: { errors: [{ detail: `no endpoint for ${p}` }] } };
    },
  };
}

function adapter(state: XReadState): XAdapter {
  return new XAdapter(fakeFabric(state), {
    nangoConnectionId: "c",
    integrationKey: "tuezday-twitter",
  });
}

// ---------------------------------------------------------------------------
// readSocialProfile
// ---------------------------------------------------------------------------

describe("XAdapter.readSocialProfile", () => {
  it("normalizes /2/users/me + recent tweets into SocialProfileReadRaw", async () => {
    const state = xReadState();
    const profile = await adapter(state).readSocialProfile();

    expect(profile.handle).toBe("tuezday_founder");
    expect(profile.displayName).toBe("Tuezday Founder");
    expect(profile.bio).toBe("GTM orchestration, brain-first.");
    expect(profile.recentPosts).toEqual([
      {
        text: "First post",
        url: "https://x.com/tuezday_founder/status/t1",
        createdAt: Date.parse("2026-06-01T10:00:00.000Z"),
      },
      { text: "Second post", url: "https://x.com/tuezday_founder/status/t2", createdAt: null },
      { text: "Third post", url: "https://x.com/tuezday_founder/status/t3", createdAt: null },
    ]);
  });

  it("requests the tweets of the id from /2/users/me, excluding retweets/replies", async () => {
    const state = xReadState();
    await adapter(state).readSocialProfile();

    expect(state.calls[0]!.method).toBe("GET");
    expect(state.calls[0]!.path).toBe("/2/users/me?user.fields=description,username,name");
    expect(state.calls[1]!.method).toBe("GET");
    expect(state.calls[1]!.path).toBe(
      "/2/users/111/tweets?max_results=25&tweet.fields=created_at&exclude=retweets,replies",
    );
  });

  it("returns an empty recentPosts list when the tweets response has an empty data array", async () => {
    const state = xReadState();
    state.tweets = { status: 200, json: { data: [] } };

    const profile = await adapter(state).readSocialProfile();
    expect(profile.recentPosts).toEqual([]);
    expect(profile.handle).toBe("tuezday_founder");
  });

  it("caps recentPosts at 25 even if the API returns more", async () => {
    const state = xReadState();
    state.tweets = {
      status: 200,
      json: {
        data: Array.from({ length: 30 }, (_, i) => ({
          id: `t${i}`,
          text: `Post ${i}`,
          created_at: "2026-06-01T10:00:00.000Z",
        })),
      },
    };

    const profile = await adapter(state).readSocialProfile();
    expect(profile.recentPosts).toHaveLength(25);
    expect(profile.recentPosts[0]!.text).toBe("Post 0");
    expect(profile.recentPosts[24]!.text).toBe("Post 24");
  });

  it("throws a ConnectorFabricError with the status when /2/users/me is non-2xx", async () => {
    const state = xReadState();
    state.me = { status: 401, json: { title: "Unauthorized" } };

    await expect(adapter(state).readSocialProfile()).rejects.toThrowError(ConnectorFabricError);
    await expect(adapter(state).readSocialProfile()).rejects.toThrowError(/401/);
  });

  it("throws a ConnectorFabricError with the status when the tweets call is non-2xx", async () => {
    const state = xReadState();
    state.tweets = { status: 429, json: { title: "Too Many Requests" } };

    await expect(adapter(state).readSocialProfile()).rejects.toThrowError(ConnectorFabricError);
    await expect(adapter(state).readSocialProfile()).rejects.toThrowError(/429/);
  });
});
