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

export interface SocialAdapter {
  publishPost(input: PublishPostInput): Promise<SocialPostResult>;
  /** Per-recipient direct message (X only this sprint). */
  sendDm?(input: { recipientHandle: string; body: string }): Promise<SocialPostResult>;
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
