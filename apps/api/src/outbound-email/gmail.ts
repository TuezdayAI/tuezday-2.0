/**
 * The Gmail mailbox boundary (Sprint 47): send outreach email from a connected
 * Gmail account and read inbound replies to threads we started. The real
 * implementation rides the connector fabric proxy (tokens live in Nango, never
 * here); tests inject a fake. `connectionId` throughout is the **Nango**
 * connection id carried on the Tuezday `connections` row.
 */

import type { ConnectorFabric } from "../connectors/fabric";

const GMAIL_BASE_URL = "https://gmail.googleapis.com";
/** Matches `integrationKeyFor` for the `gmail` provider. */
const GMAIL_INTEGRATION_KEY = "tuezday-gmail";

export interface GmailSendInput {
  /** Bare sender address (the mailbox address). */
  from: string;
  /** Display name for the From header; empty = address only. */
  fromName: string;
  to: string;
  subject: string;
  text: string;
  replyTo: string | null;
  /** Reply into an existing Gmail thread (Sprint 48 follow-ups). */
  threadId?: string;
  /** RFC-2822 Message-ID being replied to — sets In-Reply-To/References. */
  inReplyTo?: string;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  bodyText: string;
  internalDateMs: number;
}

export interface GmailProfile {
  emailAddress: string;
}

export interface GmailMailboxProvider {
  sendEmail(connectionId: string, input: GmailSendInput): Promise<GmailSendResult>;
  /** Recent inbox messages received on/after `sinceMs` (ids only — fetch matches). */
  listInboundSince(
    connectionId: string,
    sinceMs: number,
    maxResults: number,
  ): Promise<GmailMessageMeta[]>;
  getMessage(connectionId: string, messageId: string): Promise<GmailMessage>;
  getProfile(connectionId: string): Promise<GmailProfile>;
}

export class GmailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GmailProviderError";
  }
}

/** RFC 2047 B-encode a header value when it contains non-ASCII characters. */
function encodeHeaderText(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Build the RFC-2822 message Gmail's `messages.send` expects (base64url raw). */
export function buildRfc2822(input: GmailSendInput): string {
  const fromHeader = input.fromName
    ? `${encodeHeaderText(input.fromName)} <${input.from}>`
    : input.from;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderText(input.subject)}`,
  ];
  if (input.replyTo) headers.push(`Reply-To: ${input.replyTo}`);
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"');
  return `${headers.join("\r\n")}\r\n\r\n${input.text}`;
}

interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

/** Depth-first hunt for the first text/plain body in a (possibly nested) payload. */
function findPlainTextBody(part: GmailPayloadPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType?.toLowerCase().startsWith("text/plain") && part.body?.data) {
    try {
      return decodeBase64Url(part.body.data);
    } catch {
      return null;
    }
  }
  for (const child of part.parts ?? []) {
    const found = findPlainTextBody(child);
    if (found) return found;
  }
  // A simple non-multipart message keeps its body at the top level.
  if (!part.parts?.length && part.body?.data) {
    try {
      return decodeBase64Url(part.body.data);
    } catch {
      return null;
    }
  }
  return null;
}

/** Split `Jane Doe <jane@x.com>` (or a bare address) into name + address. */
export function parseAddressHeader(value: string): { name: string; address: string } {
  const match = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/.exec(value);
  if (match) return { name: (match[1] ?? "").trim(), address: match[2]!.trim().toLowerCase() };
  return { name: "", address: value.trim().toLowerCase() };
}

/** Fabric-backed Gmail REST client — the real default behind `buildApp`. */
export class FabricGmailProvider implements GmailMailboxProvider {
  constructor(private readonly fabric: ConnectorFabric) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    connectionId: string,
    body?: unknown,
  ): Promise<unknown> {
    const result = await this.fabric.proxyJson(method, path, connectionId, GMAIL_INTEGRATION_KEY, {
      ...(body === undefined ? {} : { body }),
      baseUrlOverride: GMAIL_BASE_URL,
    });
    if (result.status < 200 || result.status >= 300) {
      const detail =
        typeof result.json === "object" && result.json !== null
          ? JSON.stringify(result.json).slice(0, 300)
          : String(result.json ?? "");
      throw new GmailProviderError(`Gmail API returned ${result.status}: ${detail}`, result.status);
    }
    return result.json;
  }

  async sendEmail(connectionId: string, input: GmailSendInput): Promise<GmailSendResult> {
    const raw = base64Url(buildRfc2822(input));
    const json = (await this.request("POST", "/gmail/v1/users/me/messages/send", connectionId, {
      raw,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    })) as { id?: string; threadId?: string } | undefined;
    if (!json?.id || !json.threadId) {
      throw new GmailProviderError("Gmail send returned no message id.");
    }
    return { messageId: json.id, threadId: json.threadId };
  }

  async listInboundSince(
    connectionId: string,
    sinceMs: number,
    maxResults: number,
  ): Promise<GmailMessageMeta[]> {
    // Gmail's `after:` filter takes epoch seconds; floor keeps the overlap safe.
    const afterSeconds = Math.max(Math.floor(sinceMs / 1000), 0);
    const q = encodeURIComponent(`in:inbox after:${afterSeconds}`);
    const json = (await this.request(
      "GET",
      `/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${q}`,
      connectionId,
    )) as { messages?: Array<{ id?: string; threadId?: string }> } | undefined;
    return (json?.messages ?? [])
      .filter((m): m is { id: string; threadId: string } => !!m.id && !!m.threadId)
      .map((m) => ({ id: m.id, threadId: m.threadId }));
  }

  async getMessage(connectionId: string, messageId: string): Promise<GmailMessage> {
    const json = (await this.request(
      "GET",
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      connectionId,
    )) as
      | {
          id?: string;
          threadId?: string;
          snippet?: string;
          internalDate?: string;
          payload?: GmailPayloadPart & { headers?: Array<{ name?: string; value?: string }> };
        }
      | undefined;
    if (!json?.id || !json.threadId) {
      throw new GmailProviderError(`Gmail message ${messageId} could not be read.`);
    }
    const headers = json.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
    const from = parseAddressHeader(header("From"));
    return {
      id: json.id,
      threadId: json.threadId,
      fromAddress: from.address,
      fromName: from.name,
      subject: header("Subject"),
      // Defensive multipart parse; Gmail's snippet is the fallback body.
      bodyText: findPlainTextBody(json.payload)?.trim() || (json.snippet ?? ""),
      internalDateMs: Number(json.internalDate ?? 0) || 0,
    };
  }

  async getProfile(connectionId: string): Promise<GmailProfile> {
    const json = (await this.request("GET", "/gmail/v1/users/me/profile", connectionId)) as
      | { emailAddress?: string }
      | undefined;
    if (!json?.emailAddress) {
      throw new GmailProviderError("Gmail profile returned no email address.");
    }
    return { emailAddress: json.emailAddress };
  }
}
