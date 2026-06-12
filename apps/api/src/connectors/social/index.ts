import type { Connection, ConnectorProvider } from "@tuezday/contracts";
import type { ConnectorFabric } from "../fabric";
import { RedditAdapter } from "./reddit";

/**
 * Provider-agnostic social publishing boundary. Every platform call from
 * services goes through this interface so X/LinkedIn/Instagram adapters slot
 * in without touching the publish domain.
 */
export interface SocialPostResult {
  /** Platform id of the created post (e.g. Reddit's t3_… fullname). */
  externalId: string;
  /** Public URL of the live post. */
  url: string;
}

export interface SocialAdapter {
  publishPost(input: { target: string; title: string; body: string }): Promise<SocialPostResult>;
}

export function socialAdapterFor(
  fabric: ConnectorFabric,
  provider: ConnectorProvider,
  connection: Connection,
): SocialAdapter | undefined {
  if (!provider.categories?.includes("social")) return undefined;
  if (provider.key === "reddit") {
    return new RedditAdapter(fabric, {
      nangoConnectionId: connection.nangoConnectionId,
      integrationKey: `tuezday-${provider.key}`,
    });
  }
  // X / LinkedIn / Instagram adapters arrive in later slices.
  return undefined;
}
