import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { SocialAdapter, SocialPostResult } from "./index";
import type { SocialAdapterConfig } from "./linkedin";

const X_API = "https://api.twitter.com";

interface UserLookupResponse {
  data?: { id?: string; username?: string };
  errors?: Array<{ detail?: string; title?: string }>;
}

interface DmResponse {
  data?: { dm_conversation_id?: string; dm_event_id?: string };
  errors?: Array<{ detail?: string; title?: string }>;
  detail?: string;
  title?: string;
}

/**
 * X (Twitter) per-recipient DM via API v2. Resolve the handle to a numeric id,
 * then post into a 1:1 conversation. X restricts cold DMs (403) and rate-limits
 * (429) — both surface as a ConnectorFabricError that lands on the message.
 * DM-only this sprint; publishPost throws.
 */
export class XAdapter implements SocialAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly config: SocialAdapterConfig,
  ) {}

  async publishPost(): Promise<SocialPostResult> {
    throw new ConnectorFabricError("X is DM-only in a launch — posting tweets is not supported here.");
  }

  private async resolveUserId(handle: string): Promise<string> {
    const clean = handle.replace(/^@+/, "").trim();
    const res = await this.fabric.proxyJson(
      "GET",
      `/2/users/by/username/${encodeURIComponent(clean)}`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: X_API },
    );
    const payload = (res.json ?? {}) as UserLookupResponse;
    if (res.status < 200 || res.status >= 300 || payload.errors?.length) {
      const detail = payload.errors?.[0]?.detail ?? `status ${res.status}`;
      throw new ConnectorFabricError(`Could not find X user @${clean}: ${detail}`);
    }
    const id = payload.data?.id;
    if (!id) throw new ConnectorFabricError(`X returned no user id for @${clean}.`);
    return id;
  }

  async sendDm(input: { recipientHandle: string; body: string }): Promise<SocialPostResult> {
    const userId = await this.resolveUserId(input.recipientHandle);
    const res = await this.fabric.proxyJson(
      "POST",
      `/2/dm_conversations/with/${userId}/messages`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { body: { text: input.body }, baseUrlOverride: X_API },
    );
    const payload = (res.json ?? {}) as DmResponse;
    if (res.status < 200 || res.status >= 300 || payload.errors?.length) {
      const detail = payload.errors?.[0]?.detail ?? payload.detail ?? `status ${res.status}`;
      throw new ConnectorFabricError(`X refused the DM to @${input.recipientHandle.replace(/^@+/, "")}: ${detail}`);
    }
    const eventId = payload.data?.dm_event_id;
    if (!eventId) throw new ConnectorFabricError("X's DM response had no event id.");
    return { externalId: eventId, url: "" };
  }
}
