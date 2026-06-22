import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type {
  InboundReply,
  PostEngagement,
  PostRef,
  PublishMedia,
  PublishPostInput,
  SocialAdapter,
  SocialPostResult,
} from "./index";
import type { SocialAdapterConfig } from "./linkedin";

const GRAPH = "https://graph.facebook.com";
const V = "v23.0";
// Bounded in-request poll for reel/video processing. If still in progress after
// this, we throw and the publication retry route finishes it (deferred: a
// worker-driven async finalize — docs/deferred-improvements.md).
const VIDEO_POLL_TRIES = 10;
const VIDEO_POLL_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AccountsResponse {
  data?: Array<{ instagram_business_account?: { id?: string } }>;
}
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

/**
 * Instagram content publishing via the Facebook Graph API. The IG Business
 * account is discovered from the connected Facebook user's Pages. Publishing is
 * the two-step container → media_publish flow: single image, a single
 * video/reel (with bounded processing poll), or a 2–10 item carousel.
 */
export class InstagramAdapter implements SocialAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly config: SocialAdapterConfig,
  ) {}

  private async post(path: string, form: Record<string, string>): Promise<IdResponse> {
    const res = await this.fabric.proxyJson("POST", path, this.config.nangoConnectionId, this.config.integrationKey, {
      form,
      baseUrlOverride: GRAPH,
    });
    const json = (res.json ?? {}) as IdResponse;
    if (res.status < 200 || res.status >= 300 || json.error) {
      throw new ConnectorFabricError(`Instagram ${path} returned ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  }

  private async igUserId(): Promise<string> {
    const res = await this.fabric.proxyJson(
      "GET",
      `/${V}/me/accounts?fields=instagram_business_account{id}`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorFabricError(`Instagram account lookup returned ${res.status}.`);
    }
    const data = (res.json as AccountsResponse)?.data ?? [];
    const igId = data.map((p) => p.instagram_business_account?.id).find(Boolean);
    if (!igId) {
      throw new ConnectorFabricError(
        "No Instagram Business account is linked to this Facebook login — link an IG Business/Creator account to a Page first.",
      );
    }
    return igId;
  }

  private mediaParam(item: PublishMedia): Record<string, string> {
    return item.type === "video" ? { media_type: "REELS", video_url: item.url } : { image_url: item.url };
  }

  private async waitForContainer(creationId: string): Promise<void> {
    for (let i = 0; i < VIDEO_POLL_TRIES; i++) {
      const res = await this.fabric.proxyJson(
        "GET",
        `/${V}/${creationId}?fields=status_code`,
        this.config.nangoConnectionId,
        this.config.integrationKey,
        { baseUrlOverride: GRAPH },
      );
      const status = (res.json as StatusResponse)?.status_code;
      if (status === "FINISHED") return;
      if (status === "ERROR") throw new ConnectorFabricError("Instagram could not process the video.");
      await sleep(VIDEO_POLL_DELAY_MS);
    }
    throw new ConnectorFabricError("Instagram is still processing the video — retry this publish in a moment.");
  }

  async publishPost(input: PublishPostInput): Promise<SocialPostResult> {
    const media = input.media ?? [];
    if (media.length === 0) {
      throw new ConnectorFabricError("Instagram needs at least one image or video.");
    }
    const igId = await this.igUserId();
    const hasVideo = media.some((m) => m.type === "video");

    let creationId: string;
    if (media.length === 1) {
      const created = await this.post(`/${V}/${igId}/media`, { ...this.mediaParam(media[0]!), caption: input.body });
      creationId = created.id!;
    } else {
      const children: string[] = [];
      for (const item of media) {
        const child = await this.post(`/${V}/${igId}/media`, { ...this.mediaParam(item), is_carousel_item: "true" });
        children.push(child.id!);
      }
      const parent = await this.post(`/${V}/${igId}/media`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: input.body,
      });
      creationId = parent.id!;
    }

    if (hasVideo) await this.waitForContainer(creationId);

    const published = await this.post(`/${V}/${igId}/media_publish`, { creation_id: creationId });
    const mediaId = published.id!;

    let url = "";
    const link = await this.fabric.proxyJson(
      "GET",
      `/${V}/${mediaId}?fields=permalink`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: GRAPH },
    );
    if (link.status >= 200 && link.status < 300) {
      url = (link.json as PermalinkResponse)?.permalink ?? "";
    }
    return { externalId: mediaId, url };
  }

  // --- Sprint 29 (engagement inbox). Real Graph shape; needs an IG Business
  // account + App Review for comment access — verified-when-creds. ---

  async fetchEngagement(post: PostRef): Promise<PostEngagement> {
    const res = await this.fabric.proxyJson(
      "GET",
      `/${V}/${post.externalId}?fields=like_count,comments_count`,
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
      `/${V}/${post.externalId}/comments?fields=id,text,username,timestamp`,
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
    const created = await this.post(`/${V}/${input.parentExternalId}/replies`, { message: input.body });
    return { externalId: created.id!, url: "" };
  }
}
