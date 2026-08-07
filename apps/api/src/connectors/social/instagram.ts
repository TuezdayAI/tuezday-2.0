import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type {
  InboundReply,
  PostEngagement,
  PostRef,
  PublishMedia,
  PublishPostInput,
  SocialAdapter,
  SocialPublishResult,
  SocialPostResult,
  SocialProfileReadRaw,
} from "./index";
import type { SocialAdapterConfig } from "./linkedin";
import { ProviderCapabilityError } from "../../discovery/provider-errors";

const GRAPH = "https://graph.instagram.com";
const VIDEO_RETRY_AFTER_MS = 5_000;

interface IdResponse {
  id?: string;
  error?: { message?: string };
}
interface StatusResponse {
  status_code?: string;
  error?: { message?: string };
}
interface PermalinkResponse {
  permalink?: string;
}
interface ProfileResponse {
  username?: string;
  name?: string;
  biography?: string;
}
interface MediaListResponse {
  data?: Array<{ caption?: string; permalink?: string; timestamp?: string }>;
}

/**
 * Instagram content publishing via direct Instagram Login. OAuth completion
 * binds one professional account id; publishing is the two-step container →
 * media_publish flow for an image, video/reel, or 2–10 item carousel.
 */
export class InstagramAdapter implements SocialAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly config: SocialAdapterConfig,
  ) {}

  private async post(
    path: string,
    form: Record<string, string>,
  ): Promise<IdResponse & { id: string }> {
    const res = await this.fabric.proxyJson("POST", path, this.config.nangoConnectionId, this.config.integrationKey, {
      form,
      baseUrlOverride: GRAPH,
    });
    const json = (res.json ?? {}) as IdResponse;
    if (res.status < 200 || res.status >= 300 || json.error) {
      throw new ConnectorFabricError(`Instagram ${path} returned ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    if (!json.id?.trim()) {
      throw new ConnectorFabricError(`Instagram ${path} returned no operation id.`);
    }
    return json as IdResponse & { id: string };
  }

  private igUserId(): string {
    const accountId = this.config.externalAccountId?.trim();
    if (!accountId) {
      throw new ProviderCapabilityError(
        "reconnect_required",
        "Reconnect Instagram with direct Instagram Login.",
      );
    }
    return accountId;
  }

  private mediaParam(item: PublishMedia): Record<string, string> {
    return item.type === "video" ? { media_type: "REELS", video_url: item.url } : { image_url: item.url };
  }

  private processing(creationId: string): SocialPublishResult {
    return {
      status: "processing",
      operationId: creationId,
      retryAfterMs: VIDEO_RETRY_AFTER_MS,
    };
  }

  private async publishContainer(creationId: string): Promise<SocialPublishResult> {
    const published = await this.post(`/${this.igUserId()}/media_publish`, {
      creation_id: creationId,
    });
    const mediaId = published.id;

    let url = "";
    const link = await this.fabric.proxyJson(
      "GET",
      `/${mediaId}?fields=permalink`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (link.status >= 200 && link.status < 300) {
      url = (link.json as PermalinkResponse)?.permalink ?? "";
    }
    return { status: "published", externalId: mediaId, url };
  }

  async publishPost(input: PublishPostInput): Promise<SocialPublishResult> {
    const media = input.media ?? [];
    if (media.length === 0) {
      throw new ConnectorFabricError("Instagram needs at least one image or video.");
    }
    const igId = this.igUserId();
    const hasVideo = media.some((m) => m.type === "video");

    let creationId: string;
    if (media.length === 1) {
      const created = await this.post(`/${igId}/media`, { ...this.mediaParam(media[0]!), caption: input.body });
      creationId = created.id;
    } else {
      const children: string[] = [];
      for (const item of media) {
        const child = await this.post(`/${igId}/media`, { ...this.mediaParam(item), is_carousel_item: "true" });
        children.push(child.id);
      }
      const parent = await this.post(`/${igId}/media`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: input.body,
      });
      creationId = parent.id;
    }

    return hasVideo ? this.processing(creationId) : await this.publishContainer(creationId);
  }

  async finalizePost(operationId: string): Promise<SocialPublishResult> {
    const res = await this.fabric.proxyJson(
      "GET",
      `/${operationId}?fields=status_code`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`Instagram container lookup returned ${res.status}.`);
    }
    const status = (res.json as StatusResponse)?.status_code;
    if (status === "FINISHED") return await this.publishContainer(operationId);
    if (status === "ERROR") {
      throw new ConnectorFabricError("Instagram could not process the video.");
    }
    if (status === "IN_PROGRESS" || status === "PUBLISHED") return this.processing(operationId);
    throw new ConnectorFabricError(
      `Instagram returned an unknown container status: ${status ?? "missing"}.`,
    );
  }

  // --- Sprint 29 (engagement inbox). Real Graph shape; needs an IG Business
  // account + App Review for comment access — verified-when-creds. ---

  async fetchEngagement(post: PostRef): Promise<PostEngagement> {
    const res = await this.fabric.proxyJson(
      "GET",
      `/${post.externalId}?fields=like_count,comments_count`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`Instagram media lookup returned ${res.status}.`);
    }
    const json = (res.json ?? {}) as { like_count?: number; comments_count?: number };
    return { likes: json.like_count, comments: json.comments_count };
  }

  async fetchReplies(post: PostRef): Promise<InboundReply[]> {
    const res = await this.fabric.proxyJson(
      "GET",
      `/${post.externalId}/comments?fields=id,text,username,timestamp`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`Instagram comments returned ${res.status}.`);
    }
    const data =
      ((res.json ?? {}) as { data?: Array<{ id?: string; text?: string; username?: string; timestamp?: string }> })
        .data ?? [];
    return data
      .filter((c) => c.id && c.text)
      .map((c) => ({
        externalId: c.id!,
        parentExternalId: post.externalId,
        authorHandle: c.username ?? "",
        authorName: c.username ?? "",
        body: c.text!,
        createdAt: c.timestamp ? Date.parse(c.timestamp) : Date.now(),
      }));
  }

  async postReply(input: { parentExternalId: string; body: string }): Promise<SocialPostResult> {
    const created = await this.post(`/${input.parentExternalId}/replies`, { message: input.body });
    return { externalId: created.id, url: "" };
  }

  // --- Sprint 36.3 (onboarding social corpus): the connected IG Business
  // account's own profile + recent media. ---

  async readSocialProfile(): Promise<SocialProfileReadRaw> {
    const igId = this.igUserId();

    const profileRes = await this.fabric.proxyJson(
      "GET",
      `/${igId}?fields=username,name,biography`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (profileRes.status < 200 || profileRes.status >= 300) {
      throw new ConnectorFabricError(
        `Instagram profile lookup returned ${profileRes.status}: ${JSON.stringify(profileRes.json ?? {}).slice(0, 200)}`,
      );
    }
    const profile = (profileRes.json ?? {}) as ProfileResponse;

    const mediaRes = await this.fabric.proxyJson(
      "GET",
      `/${igId}/media?fields=caption,permalink,timestamp&limit=25`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (mediaRes.status < 200 || mediaRes.status >= 300) {
      throw new ConnectorFabricError(
        `Instagram media list returned ${mediaRes.status}: ${JSON.stringify(mediaRes.json ?? {}).slice(0, 200)}`,
      );
    }
    const items = ((mediaRes.json ?? {}) as MediaListResponse).data ?? [];

    return {
      handle: profile.username ?? "",
      displayName: profile.name ?? profile.username ?? "",
      bio: profile.biography ?? "",
      recentPosts: items.slice(0, 25).map((m) => {
        const parsed = m.timestamp ? Date.parse(m.timestamp) : NaN;
        return {
          text: m.caption ?? "",
          url: m.permalink ?? "",
          createdAt: Number.isFinite(parsed) ? parsed : null,
        };
      }),
    };
  }
}
