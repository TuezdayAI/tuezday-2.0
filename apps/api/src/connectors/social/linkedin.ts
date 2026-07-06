import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type {
  InboundReply,
  PostEngagement,
  PostRef,
  PublishPostInput,
  SocialAdapter,
  SocialPostResult,
  SocialProfileReadRaw,
} from "./index";

const LINKEDIN_API = "https://api.linkedin.com";

export interface SocialAdapterConfig {
  nangoConnectionId: string;
  integrationKey: string;
}

interface UserInfoResponse {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

interface RestPostElement {
  id?: string;
  commentary?: string;
  createdAt?: number;
  publishedAt?: number;
}

interface RestPostsResponse {
  elements?: RestPostElement[];
}

interface UgcPostResponse {
  id?: string;
}

interface SocialActionsSummary {
  likesSummary?: { totalLikes?: number };
  commentsSummary?: { aggregatedTotalComments?: number };
}

interface SocialActionComment {
  id?: string;
  actor?: string;
  parentComment?: string;
  message?: { text?: string };
  created?: { time?: number };
}

interface CommentsListResponse {
  elements?: SocialActionComment[];
}

interface CreatedCommentResponse {
  id?: string;
}

/**
 * LinkedIn member share via /v2/ugcPosts (w_member_social). Posts to the
 * connected member's own feed — org-page posting needs w_organization_social,
 * out of scope this sprint. Text only; media is ignored.
 */
export class LinkedInAdapter implements SocialAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly config: SocialAdapterConfig,
  ) {}

  private async authorUrn(): Promise<string> {
    const me = await this.fabric.proxyJson("GET", "/v2/userinfo", this.config.nangoConnectionId, this.config.integrationKey, {
      baseUrlOverride: LINKEDIN_API,
    });
    if (me.status < 200 || me.status >= 300) {
      throw new ConnectorFabricError(`LinkedIn identity lookup returned ${me.status}.`);
    }
    const sub = (me.json as UserInfoResponse)?.sub;
    if (!sub) throw new ConnectorFabricError("LinkedIn did not return a member id — reconnect the account.");
    return `urn:li:person:${sub}`;
  }

  async publishPost(input: PublishPostInput): Promise<SocialPostResult> {
    const author = await this.authorUrn();
    const result = await this.fabric.proxyJson(
      "POST",
      "/v2/ugcPosts",
      this.config.nangoConnectionId,
      this.config.integrationKey,
      {
        body: {
          author,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text: input.body },
              shareMediaCategory: "NONE",
            },
          },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
        },
        headers: { "X-Restli-Protocol-Version": "2.0.0" },
        baseUrlOverride: LINKEDIN_API,
      },
    );
    if (result.status < 200 || result.status >= 300) {
      const snippet = result.json ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(`LinkedIn post returned ${result.status}: ${snippet}`);
    }
    const id = (result.json as UgcPostResponse)?.id;
    if (!id) throw new ConnectorFabricError("LinkedIn's response had no post id.");
    return { externalId: id, url: `https://www.linkedin.com/feed/update/${id}` };
  }

  // --- Sprint 29 (engagement inbox). Real /v2/socialActions shape; needs
  // r_member_social/w_member_social — verified-when-creds (untested without a
  // live LinkedIn Marketing app). ---

  async fetchEngagement(post: PostRef): Promise<PostEngagement> {
    const urn = encodeURIComponent(post.externalId);
    const res = await this.fabric.proxyJson(
      "GET",
      `/v2/socialActions/${urn}`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "X-Restli-Protocol-Version": "2.0.0" }, baseUrlOverride: LINKEDIN_API },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`LinkedIn socialActions returned ${res.status}.`);
    }
    const summary = (res.json ?? {}) as SocialActionsSummary;
    return {
      likes: summary.likesSummary?.totalLikes,
      comments: summary.commentsSummary?.aggregatedTotalComments,
    };
  }

  async fetchReplies(post: PostRef): Promise<InboundReply[]> {
    const urn = encodeURIComponent(post.externalId);
    const res = await this.fabric.proxyJson(
      "GET",
      `/v2/socialActions/${urn}/comments`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { headers: { "X-Restli-Protocol-Version": "2.0.0" }, baseUrlOverride: LINKEDIN_API },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`LinkedIn comments returned ${res.status}.`);
    }
    const elements = ((res.json ?? {}) as CommentsListResponse).elements ?? [];
    return elements
      .filter((c) => c.id && c.message?.text)
      .map((c) => ({
        externalId: c.id!,
        parentExternalId: c.parentComment ?? post.externalId,
        authorHandle: c.actor ?? "",
        authorName: c.actor ?? "",
        body: c.message!.text!,
        createdAt: c.created?.time ?? Date.now(),
      }));
  }

  async postReply(input: { parentExternalId: string; body: string }): Promise<SocialPostResult> {
    const author = await this.authorUrn();
    const urn = encodeURIComponent(input.parentExternalId);
    const res = await this.fabric.proxyJson(
      "POST",
      `/v2/socialActions/${urn}/comments`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      {
        body: { actor: author, message: { text: input.body } },
        headers: { "X-Restli-Protocol-Version": "2.0.0" },
        baseUrlOverride: LINKEDIN_API,
      },
    );
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.json ? JSON.stringify(res.json).slice(0, 200) : "";
      throw new ConnectorFabricError(`LinkedIn comment returned ${res.status}: ${snippet}`);
    }
    const id = (res.json as CreatedCommentResponse)?.id;
    if (!id) throw new ConnectorFabricError("LinkedIn's comment response had no id.");
    return { externalId: id, url: "" };
  }

  // --- Sprint 36.3 (onboarding social corpus). Profile via OpenID
  // /v2/userinfo (no bio there — LinkedIn keeps the summary behind partner
  // scopes) and recent original posts via the versioned /rest/posts API. ---

  async readSocialProfile(): Promise<SocialProfileReadRaw> {
    const me = await this.fabric.proxyJson("GET", "/v2/userinfo", this.config.nangoConnectionId, this.config.integrationKey, {
      baseUrlOverride: LINKEDIN_API,
    });
    if (me.status < 200 || me.status >= 300) {
      throw new ConnectorFabricError(`LinkedIn identity lookup returned ${me.status}.`);
    }
    const info = ((me.json ?? {}) as UserInfoResponse);
    const nameParts = [info.given_name, info.family_name].filter((p): p is string => Boolean(p));
    const handle = nameParts.length
      ? nameParts.join(" ").trim().toLowerCase().replace(/\s+/g, "-")
      : "";

    const author = await this.authorUrn();
    const res = await this.fabric.proxyJson(
      "GET",
      `/rest/posts?author=${encodeURIComponent(author)}&q=author&count=25&sortBy=LAST_MODIFIED`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      {
        headers: { "X-Restli-Protocol-Version": "2.0.0", "LinkedIn-Version": "202411" },
        baseUrlOverride: LINKEDIN_API,
      },
    );
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.json ? JSON.stringify(res.json).slice(0, 200) : "";
      throw new ConnectorFabricError(`LinkedIn posts read returned ${res.status}: ${snippet}`);
    }
    const elements = ((res.json ?? {}) as RestPostsResponse).elements ?? [];
    const recentPosts = elements.slice(0, 25).map((post) => ({
      text: post.commentary ?? "",
      url: post.id ? `https://www.linkedin.com/feed/update/${post.id}` : "",
      createdAt: post.createdAt ?? post.publishedAt ?? null,
    }));

    return {
      handle,
      displayName: info.name ?? nameParts.join(" ").trim(),
      bio: "",
      recentPosts,
    };
  }
}
