import { describe, expect, it } from "vitest";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import { RedditAdapter } from "../src/connectors/social/reddit";

const ME = {
  data: {
    name: "hexalog_founder",
    total_karma: 4200,
    subreddit: { title: "Hexalog", public_description: "Logs, but hexagonal." },
  },
};
const SUBMITTED = {
  data: {
    children: [
      {
        data: {
          title: "We shipped hex packing",
          selftext: "Here is how it works…",
          permalink: "/r/devops/comments/1/we_shipped/",
          created_utc: 1_780_000_000,
        },
      },
      { data: { title: "Ask me anything", selftext: "", permalink: "/r/x/2/ama/", created_utc: 0 } },
    ],
  },
};

function fabric(opts?: { failMe?: boolean; failPosts?: boolean }): ConnectorFabric {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    health: async () => ({ healthy: true }),
    ensureIntegration: async () => {},
    createConnectSession: unused,
    importConnection: async () => {},
    connectionExists: async () => true,
    deleteConnection: async () => {},
    proxyGet: unused,
    async proxyJson(_m, path): Promise<ProxyJsonResult> {
      if (path.startsWith("/api/v1/me")) {
        return opts?.failMe ? { status: 403, json: {} } : { status: 200, json: ME };
      }
      if (/^\/user\/.+\/submitted/.test(path)) {
        return opts?.failPosts ? { status: 500, json: {} } : { status: 200, json: SUBMITTED };
      }
      return { status: 404, json: {} };
    },
  };
}

function adapter(f: ConnectorFabric) {
  return new RedditAdapter(f, { nangoConnectionId: "c", integrationKey: "tuezday-reddit" });
}

describe("RedditAdapter.readSocialProfile", () => {
  it("normalizes profile + recent submissions", async () => {
    const p = await adapter(fabric()).readSocialProfile();
    expect(p.handle).toBe("hexalog_founder");
    expect(p.displayName).toBe("Hexalog");
    expect(p.bio).toBe("Logs, but hexagonal.");
    expect(p.recentPosts).toHaveLength(2);
    expect(p.recentPosts[0]!.text).toContain("We shipped hex packing");
    expect(p.recentPosts[0]!.text).toContain("Here is how it works");
    expect(p.recentPosts[0]!.url).toBe("https://www.reddit.com/r/devops/comments/1/we_shipped/");
    expect(p.recentPosts[0]!.createdAt).toBe(1_780_000_000_000);
    expect(p.recentPosts[1]!.createdAt).toBeNull();
  });

  it("throws when /api/v1/me fails", async () => {
    await expect(adapter(fabric({ failMe: true })).readSocialProfile()).rejects.toThrow();
  });

  it("throws when the submissions listing fails", async () => {
    await expect(adapter(fabric({ failPosts: true })).readSocialProfile()).rejects.toThrow();
  });
});
