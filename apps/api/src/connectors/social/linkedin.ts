import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { PublishPostInput, SocialAdapter, SocialPostResult } from "./index";

const LINKEDIN_API = "https://api.linkedin.com";

export interface SocialAdapterConfig {
  nangoConnectionId: string;
  integrationKey: string;
}

interface UserInfoResponse {
  sub?: string;
}

interface UgcPostResponse {
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
}
