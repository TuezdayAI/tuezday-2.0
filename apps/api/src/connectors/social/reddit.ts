import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type {
  InboundReply,
  PostEngagement,
  PostRef,
  SocialAdapter,
  SocialPostResult,
  SocialProfileReadRaw,
} from "./index";

const REDDIT_API = "https://oauth.reddit.com";
// Reddit throttles unidentified clients hard — always send a descriptive UA.
const USER_AGENT = "web:tuezday:v0.1 (GTM orchestration)";

interface RedditSubmitResponse {
  json?: {
    errors?: string[][];
    data?: { name?: string; url?: string };
  };
}

interface RedditThing {
  kind?: string;
  data?: {
    name?: string;
    parent_id?: string;
    author?: string;
    body?: string;
    permalink?: string;
    created_utc?: number;
    score?: number;
    num_comments?: number;
  };
}

interface RedditCommentResponse {
  json?: {
    errors?: string[][];
    data?: { things?: RedditThing[] };
  };
}

/** Strip Reddit's fullname prefix (t3_/t1_) to the bare id. */
function bareId(fullname: string): string {
  return fullname.replace(/^t\d_/, "");
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

  /** Top-level comments on our submission. `externalId` is the t3_ fullname. */
  async fetchReplies(post: PostRef): Promise<InboundReply[]> {
    const result = await this.fabric.proxyJson(
      "GET",
      `/comments/${bareId(post.externalId)}`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "User-Agent": USER_AGENT }, baseUrlOverride: REDDIT_API },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new ConnectorFabricError(`Reddit comment listing returned ${result.status}.`);
    }
    // Reddit returns [postListing, commentsListing]; we want the second.
    const listings = Array.isArray(result.json) ? (result.json as Array<{ data?: { children?: RedditThing[] } }>) : [];
    const children = listings[1]?.data?.children ?? [];
    const replies: InboundReply[] = [];
    for (const thing of children) {
      if (thing.kind !== "t1" || !thing.data?.name || !thing.data.body) continue;
      replies.push({
        externalId: thing.data.name,
        parentExternalId: thing.data.parent_id ?? post.externalId,
        authorHandle: thing.data.author ?? "",
        authorName: thing.data.author ?? "",
        body: thing.data.body,
        url: thing.data.permalink ? `https://www.reddit.com${thing.data.permalink}` : undefined,
        createdAt: thing.data.created_utc ? Math.round(thing.data.created_utc * 1000) : Date.now(),
      });
    }
    return replies;
  }

  async fetchEngagement(post: PostRef): Promise<PostEngagement> {
    const result = await this.fabric.proxyJson(
      "GET",
      `/api/info?id=${post.externalId}`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "User-Agent": USER_AGENT }, baseUrlOverride: REDDIT_API },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new ConnectorFabricError(`Reddit info returned ${result.status}.`);
    }
    const data = (result.json as { data?: { children?: RedditThing[] } })?.data?.children?.[0]?.data;
    return { likes: data?.score, comments: data?.num_comments };
  }

  /** Reply to a post or comment. `parentExternalId` is the t3_/t1_ fullname. */
  async postReply(input: { parentExternalId: string; body: string }): Promise<SocialPostResult> {
    const result = await this.fabric.proxyJson(
      "POST",
      "/api/comment",
      this.config.nangoConnectionId,
      this.config.integrationKey,
      {
        form: { api_type: "json", thing_id: input.parentExternalId, text: input.body },
        headers: { "User-Agent": USER_AGENT },
        baseUrlOverride: REDDIT_API,
      },
    );
    if (result.status < 200 || result.status >= 300) {
      const snippet = result.json ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(`Reddit comment returned ${result.status}: ${snippet}`);
    }
    const payload = (result.json ?? {}) as RedditCommentResponse;
    const errors = payload.json?.errors ?? [];
    if (errors.length > 0) {
      const detail = errors.map((e) => e.filter(Boolean).join(": ")).join("; ");
      throw new ConnectorFabricError(`Reddit refused the reply — ${detail}`);
    }
    const thing = payload.json?.data?.things?.[0]?.data;
    if (!thing?.name) {
      throw new ConnectorFabricError("Reddit's comment response had no comment id.");
    }
    return {
      externalId: thing.name,
      url: thing.permalink ? `https://www.reddit.com${thing.permalink}` : "",
    };
  }

  /** Onboarding read (Sprint 36.7): the connected account's own identity +
   * recent submissions, for the brain draft. */
  async readSocialProfile(): Promise<SocialProfileReadRaw> {
    const me = await this.fabric.proxyJson(
      "GET",
      "/api/v1/me",
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "User-Agent": USER_AGENT }, baseUrlOverride: REDDIT_API },
    );
    if (me.status < 200 || me.status >= 300) {
      throw new ConnectorFabricError(`Reddit /api/v1/me returned ${me.status}.`);
    }
    const account = ((me.json ?? {}) as {
      data?: { name?: string; subreddit?: { title?: string; public_description?: string } };
    }).data;
    // Reddit's /api/v1/me is unwrapped (no "data" envelope) for some tokens.
    const acc = account ?? (me.json as { name?: string; subreddit?: { title?: string; public_description?: string } });
    const handle = acc?.name ?? "";

    const submitted = await this.fabric.proxyJson(
      "GET",
      `/user/${encodeURIComponent(handle)}/submitted?limit=25`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "User-Agent": USER_AGENT }, baseUrlOverride: REDDIT_API },
    );
    if (submitted.status < 200 || submitted.status >= 300) {
      throw new ConnectorFabricError(`Reddit submissions returned ${submitted.status}.`);
    }
    const children =
      ((submitted.json ?? {}) as {
        data?: { children?: { data?: { title?: string; selftext?: string; permalink?: string; created_utc?: number } }[] };
      }).data?.children ?? [];

    const recentPosts = children.slice(0, 25).map((c) => {
      const d = c.data ?? {};
      const title = d.title ?? "";
      const body = d.selftext?.trim() ? `\n${d.selftext.trim()}` : "";
      return {
        text: `${title}${body}`.trim(),
        url: d.permalink ? `https://www.reddit.com${d.permalink}` : "",
        createdAt: d.created_utc ? d.created_utc * 1000 : null,
      };
    });

    return {
      handle,
      displayName: acc?.subreddit?.title || handle,
      bio: acc?.subreddit?.public_description ?? "",
      recentPosts,
    };
  }
}
