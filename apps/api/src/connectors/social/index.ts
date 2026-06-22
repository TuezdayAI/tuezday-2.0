import type { Connection, ConnectorProvider } from "@tuezday/contracts";
import type { ConnectorFabric } from "../fabric";
import { InstagramAdapter } from "./instagram";
import { LinkedInAdapter } from "./linkedin";
import { RedditAdapter } from "./reddit";
import { XAdapter } from "./x";

/**
 * Provider-agnostic social publishing boundary. Every platform call from
 * services goes through this interface so X/LinkedIn/Instagram adapters slot
 * in without touching the publish domain.
 */
export interface SocialPostResult {
  /** Platform id of the created post (e.g. Reddit's t3_… fullname). */
  externalId: string;
  /** Public URL of the live post (empty when the platform returns none, e.g. a DM). */
  url: string;
}

/** Media attached to a post (Instagram). url must be publicly fetchable by the platform. */
export interface PublishMedia {
  url: string;
  type: "image" | "video";
}

export interface PublishPostInput {
  target: string;
  title: string;
  body: string;
  media?: PublishMedia[];
}

/** A reference to one of our published posts on the platform. */
export interface PostRef {
  externalId: string;
  target?: string;
}

/** An inbound comment/DM reply pulled from the platform (Sprint 29). */
export interface InboundReply {
  externalId: string;
  parentExternalId?: string;
  authorHandle: string;
  authorName?: string;
  body: string;
  url?: string;
  /** When the reply was created on the platform, epoch ms. */
  createdAt: number;
}

/** Engagement counts on a post; fields the platform doesn't expose are omitted. */
export interface PostEngagement {
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  clicks?: number;
}

export interface SocialAdapter {
  publishPost(input: PublishPostInput): Promise<SocialPostResult>;
  /** Per-recipient direct message (X only this sprint). */
  sendDm?(input: { recipientHandle: string; body: string }): Promise<SocialPostResult>;
  // --- Sprint 29 (engagement inbox) — all optional; the poller feature-detects. ---
  /** Comments/replies on one of our published posts. */
  fetchReplies?(post: PostRef): Promise<InboundReply[]>;
  /** Engagement counts for one of our published posts. */
  fetchEngagement?(post: PostRef): Promise<PostEngagement>;
  /** Post a reply to a comment/post we received. */
  postReply?(input: { parentExternalId: string; body: string; target?: string }): Promise<SocialPostResult>;
  /** Inbound replies in an outbound DM thread (X). */
  fetchDmReplies?(input: { recipientHandle: string; sinceMs?: number }): Promise<InboundReply[]>;
}

export function socialAdapterFor(
  fabric: ConnectorFabric,
  provider: ConnectorProvider,
  connection: Connection,
): SocialAdapter | undefined {
  if (!provider.categories?.includes("social")) return undefined;
  const config = {
    nangoConnectionId: connection.nangoConnectionId,
    integrationKey: `tuezday-${provider.key}`,
  };
  switch (provider.key) {
    case "reddit":
      return new RedditAdapter(fabric, config);
    case "linkedin":
      return new LinkedInAdapter(fabric, config);
    case "instagram":
      return new InstagramAdapter(fabric, config);
    case "twitter":
      return new XAdapter(fabric, config);
    default:
      return undefined;
  }
}
