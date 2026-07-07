import { ConnectorFabricError, type ConnectorFabric } from "../fabric";
import type { InboundReply, SocialAdapter, SocialPostResult, SocialProfileReadRaw } from "./index";
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

interface DmEvent {
  id?: string;
  text?: string;
  sender_id?: string;
  created_at?: string;
}

interface DmEventsResponse {
  data?: DmEvent[];
  errors?: Array<{ detail?: string; title?: string }>;
}

interface MeResponse {
  data?: { id?: string; username?: string; name?: string; description?: string };
  errors?: Array<{ detail?: string; title?: string }>;
}

interface TweetsResponse {
  data?: Array<{ id?: string; text?: string; created_at?: string }>;
  errors?: Array<{ detail?: string; title?: string }>;
}

/** Short body snippet for error messages when X gives no structured detail. */
function bodySnippet(json: unknown): string {
  try {
    return JSON.stringify(json ?? {}).slice(0, 200);
  } catch {
    return "";
  }
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

  // --- Sprint 29 (engagement inbox). DM-only platform, so the inbound side is
  // DM replies. Real /2 DM-events shape; needs dm.read — verified-when-creds. ---

  /** Inbound DM replies from a recipient, newer than sinceMs. */
  async fetchDmReplies(input: { recipientHandle: string; sinceMs?: number }): Promise<InboundReply[]> {
    const userId = await this.resolveUserId(input.recipientHandle);
    const res = await this.fabric.proxyJson(
      "GET",
      `/2/dm_conversations/with/${userId}/dm_events?dm_event.fields=sender_id,created_at,text&max_results=50`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: X_API },
    );
    const payload = (res.json ?? {}) as DmEventsResponse;
    if (res.status < 200 || res.status >= 300 || payload.errors?.length) {
      const detail = payload.errors?.[0]?.detail ?? `status ${res.status}`;
      throw new ConnectorFabricError(`X DM events for @${input.recipientHandle.replace(/^@+/, "")}: ${detail}`);
    }
    const sinceMs = input.sinceMs ?? 0;
    const events = payload.data ?? [];
    // Keep only messages the recipient sent (sender_id === their id), newer than sinceMs.
    return events
      .filter((e) => e.id && e.text && e.sender_id === userId)
      .map((e) => ({
        externalId: e.id!,
        authorHandle: input.recipientHandle.replace(/^@+/, ""),
        authorName: input.recipientHandle.replace(/^@+/, ""),
        body: e.text!,
        createdAt: e.created_at ? Date.parse(e.created_at) : Date.now(),
      }))
      .filter((r) => r.createdAt > sinceMs);
  }

  // --- Sprint 36.3 (onboarding social corpus): the connected account's own
  // profile + recent original tweets, normalized for the read pipeline. ---

  async readSocialProfile(): Promise<SocialProfileReadRaw> {
    const meRes = await this.fabric.proxyJson(
      "GET",
      "/2/users/me?user.fields=description,username,name",
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: X_API },
    );
    const me = (meRes.json ?? {}) as MeResponse;
    if (meRes.status < 200 || meRes.status >= 300 || me.errors?.length) {
      const detail = me.errors?.[0]?.detail ?? bodySnippet(meRes.json);
      throw new ConnectorFabricError(`X profile read failed (status ${meRes.status}): ${detail}`);
    }
    const userId = me.data?.id;
    const handle = me.data?.username;
    if (!userId || !handle) throw new ConnectorFabricError("X /2/users/me returned no user id/username.");

    const tweetsRes = await this.fabric.proxyJson(
      "GET",
      `/2/users/${userId}/tweets?max_results=25&tweet.fields=created_at&exclude=retweets,replies`,
      this.config.nangoConnectionId,
      this.config.integrationKey,
      { baseUrlOverride: X_API },
    );
    const tweets = (tweetsRes.json ?? {}) as TweetsResponse;
    if (tweetsRes.status < 200 || tweetsRes.status >= 300 || tweets.errors?.length) {
      const detail = tweets.errors?.[0]?.detail ?? bodySnippet(tweetsRes.json);
      throw new ConnectorFabricError(`X recent-tweets read failed (status ${tweetsRes.status}): ${detail}`);
    }

    const recentPosts = (tweets.data ?? [])
      .filter((t) => t.id && t.text)
      .slice(0, 25)
      .map((t) => {
        const parsed = t.created_at ? Date.parse(t.created_at) : Number.NaN;
        return {
          text: t.text!,
          url: `https://x.com/${handle}/status/${t.id}`,
          createdAt: Number.isNaN(parsed) ? null : parsed,
        };
      });

    return {
      handle,
      displayName: me.data?.name ?? handle,
      bio: me.data?.description ?? "",
      recentPosts,
    };
  }

  /** Reply within a DM thread — send another message to the recipient (`target`). */
  async postReply(input: { parentExternalId: string; body: string; target?: string }): Promise<SocialPostResult> {
    if (!input.target) {
      throw new ConnectorFabricError("X reply needs the recipient handle (target).");
    }
    return this.sendDm({ recipientHandle: input.target, body: input.body });
  }
}
