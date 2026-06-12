import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { SocialAdapter, SocialPostResult } from "./index";

const REDDIT_API = "https://oauth.reddit.com";
// Reddit throttles unidentified clients hard — always send a descriptive UA.
const USER_AGENT = "web:tuezday:v0.1 (GTM orchestration)";

interface RedditSubmitResponse {
  json?: {
    errors?: string[][];
    data?: { name?: string; url?: string };
  };
}

export interface RedditAdapterConfig {
  nangoConnectionId: string;
  integrationKey: string;
}

export class RedditAdapter implements SocialAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly config: RedditAdapterConfig,
  ) {}

  async publishPost(input: { target: string; title: string; body: string }): Promise<SocialPostResult> {
    const result = await this.fabric.proxyJson(
      "POST",
      "/api/submit",
      this.config.nangoConnectionId,
      this.config.integrationKey,
      {
        form: {
          api_type: "json",
          kind: "self",
          sr: input.target.replace(/^r\//, ""),
          title: input.title,
          text: input.body,
          resubmit: "true",
        },
        headers: { "User-Agent": USER_AGENT },
        baseUrlOverride: REDDIT_API,
      },
    );
    if (result.status < 200 || result.status >= 300) {
      const snippet = result.json ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(`Reddit submit returned ${result.status}: ${snippet}`);
    }
    // Reddit reports business errors inside a 200 (e.g. SUBREDDIT_NOEXIST,
    // RATELIMIT) — surface them the same way as transport failures.
    const payload = (result.json ?? {}) as RedditSubmitResponse;
    const errors = payload.json?.errors ?? [];
    if (errors.length > 0) {
      const detail = errors.map((e) => e.filter(Boolean).join(": ")).join("; ");
      throw new ConnectorFabricError(`Reddit refused the post — ${detail}`);
    }
    const name = payload.json?.data?.name;
    const url = payload.json?.data?.url;
    if (!name || !url) {
      throw new ConnectorFabricError("Reddit's submit response had no post id/url.");
    }
    return { externalId: name, url };
  }
}
