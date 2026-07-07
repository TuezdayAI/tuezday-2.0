import { describe, expect, it } from "vitest";
import { ConnectorFabricError, type ConnectorFabric, type ProxyJsonResult } from "../src/connectors/fabric";
import { InstagramAdapter } from "../src/connectors/social/instagram";

// ---------------------------------------------------------------------------
// InstagramAdapter.readSocialProfile (Sprint 36.3 — onboarding social corpus)
//
// Fake fabric keyed on Graph API path. igUserId() resolves the IG Business
// user via GET /me/accounts, so the fake must answer that lookup too.
// ---------------------------------------------------------------------------

const V = "v23.0";
const ACCOUNTS_PATH = `/${V}/me/accounts?fields=instagram_business_account{id}`;
const PROFILE_PATH = `/${V}/ig-user-1?fields=username,name,biography`;
const MEDIA_PATH = `/${V}/ig-user-1/media?fields=caption,permalink,timestamp&limit=25`;

const accountsOk: ProxyJsonResult = {
  status: 200,
  json: { data: [{ instagram_business_account: { id: "ig-user-1" } }] },
};

function adapterFor(routes: Record<string, ProxyJsonResult>, calls: string[] = []): InstagramAdapter {
  const fabric = {
    async proxyJson(method: "GET" | "POST", path: string): Promise<ProxyJsonResult> {
      calls.push(`${method} ${path}`);
      const res = routes[path];
      if (!res) throw new Error(`Unexpected proxy call: ${method} ${path}`);
      return res;
    },
  } as unknown as ConnectorFabric;
  return new InstagramAdapter(fabric, {
    nangoConnectionId: "c",
    integrationKey: "tuezday-instagram",
  });
}

describe("InstagramAdapter.readSocialProfile", () => {
  it("normalizes profile fields and recent posts from the Graph API", async () => {
    const calls: string[] = [];
    const adapter = adapterFor(
      {
        [ACCOUNTS_PATH]: accountsOk,
        [PROFILE_PATH]: {
          status: 200,
          json: { username: "tuezhq", name: "Tuezday HQ", biography: "GTM brain for founders" },
        },
        [MEDIA_PATH]: {
          status: 200,
          json: {
            data: [
              {
                caption: "Launch day!",
                permalink: "https://www.instagram.com/p/abc/",
                timestamp: "2026-06-01T12:00:00+0000",
              },
              // caption-less media (e.g. a plain reel) → text ""
              { permalink: "https://www.instagram.com/p/def/", timestamp: "2026-05-20T08:30:00+0000" },
              // missing timestamp → createdAt null
              { caption: "Old one", permalink: "https://www.instagram.com/p/ghi/" },
            ],
          },
        },
      },
      calls,
    );

    const profile = await adapter.readSocialProfile();
    expect(profile.handle).toBe("tuezhq");
    expect(profile.displayName).toBe("Tuezday HQ");
    expect(profile.bio).toBe("GTM brain for founders");
    expect(profile.recentPosts).toEqual([
      {
        text: "Launch day!",
        url: "https://www.instagram.com/p/abc/",
        createdAt: Date.parse("2026-06-01T12:00:00+0000"),
      },
      { text: "", url: "https://www.instagram.com/p/def/", createdAt: Date.parse("2026-05-20T08:30:00+0000") },
      { text: "Old one", url: "https://www.instagram.com/p/ghi/", createdAt: null },
    ]);
    expect(calls).toEqual([`GET ${ACCOUNTS_PATH}`, `GET ${PROFILE_PATH}`, `GET ${MEDIA_PATH}`]);
  });

  it("falls back to username for displayName and empty strings for missing fields", async () => {
    const adapter = adapterFor({
      [ACCOUNTS_PATH]: accountsOk,
      [PROFILE_PATH]: { status: 200, json: { username: "tuezhq" } },
      [MEDIA_PATH]: { status: 200, json: { data: [{}] } },
    });
    const profile = await adapter.readSocialProfile();
    expect(profile.handle).toBe("tuezhq");
    expect(profile.displayName).toBe("tuezhq");
    expect(profile.bio).toBe("");
    expect(profile.recentPosts).toEqual([{ text: "", url: "", createdAt: null }]);
  });

  it("returns [] when the media list has no data", async () => {
    const adapter = adapterFor({
      [ACCOUNTS_PATH]: accountsOk,
      [PROFILE_PATH]: { status: 200, json: { username: "tuezhq", name: "Tuezday HQ", biography: "" } },
      [MEDIA_PATH]: { status: 200, json: {} },
    });
    const profile = await adapter.readSocialProfile();
    expect(profile.recentPosts).toEqual([]);
  });

  it("caps recent posts at 25 even if the platform returns more", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      caption: `post ${i}`,
      permalink: `https://www.instagram.com/p/${i}/`,
      timestamp: "2026-06-01T12:00:00+0000",
    }));
    const adapter = adapterFor({
      [ACCOUNTS_PATH]: accountsOk,
      [PROFILE_PATH]: { status: 200, json: { username: "tuezhq" } },
      [MEDIA_PATH]: { status: 200, json: { data: many } },
    });
    const profile = await adapter.readSocialProfile();
    expect(profile.recentPosts).toHaveLength(25);
    expect(profile.recentPosts[0]?.text).toBe("post 0");
  });

  it("throws ConnectorFabricError when the profile lookup is non-2xx", async () => {
    const adapter = adapterFor({
      [ACCOUNTS_PATH]: accountsOk,
      [PROFILE_PATH]: { status: 403, json: { error: { message: "permission denied" } } },
    });
    await expect(adapter.readSocialProfile()).rejects.toThrow(ConnectorFabricError);
    await expect(adapter.readSocialProfile()).rejects.toThrow(/403/);
  });

  it("throws ConnectorFabricError when the media list is non-2xx", async () => {
    const adapter = adapterFor({
      [ACCOUNTS_PATH]: accountsOk,
      [PROFILE_PATH]: { status: 200, json: { username: "tuezhq" } },
      [MEDIA_PATH]: { status: 500, json: { error: { message: "boom" } } },
    });
    await expect(adapter.readSocialProfile()).rejects.toThrow(ConnectorFabricError);
    await expect(adapter.readSocialProfile()).rejects.toThrow(/500/);
  });
});
