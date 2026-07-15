"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Input, Textarea } from "@/src/components/ui/input";
import { BrandIcon, Icon } from "@/src/components/ui/icon";
import type { BrandName } from "@/src/components/ui/brand-icons";
import styles from "./connectors.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  authorizeNangoOAuth,
  oauthSessionErrorMessage,
  type NangoOAuthSession,
} from "@/lib/nango-oauth";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  connectorHubGroups,
  EVENT_TYPES,
  integrationProgress,
  type Connection,
  type ConnectorProvider,
  type EmailSender,
  type EventType,
  type WebhookSubscription,
  type Workspace,
} from "@tuezday/contracts";
import { connectionLabel } from "@/lib/persona-social-routing";
import { ScopedActionPolicy } from "@/src/components/scoped-action-policy";

/** The API decorates OAuth providers with whether their app creds are set. */
type ProviderView = ConnectorProvider & { oauthConfigured?: boolean };

/** Providers with a real brand mark (spec §4 carve-out); the rest get the plug. */
const PROVIDER_BRAND: Record<string, BrandName> = {
  linkedin: "linkedin",
  twitter: "x",
  reddit: "reddit",
  instagram: "instagram",
  meta_ads: "meta",
  freshsales: "freshsales",
};

/** One-line GTM value promise per provider (spec §5.7.2) — outcome, not feature. */
const PROVIDER_PROMISE: Record<string, string> = {
  linkedin: "Publish approved posts on schedule, straight from Review",
  twitter: "Post approved content and reply from your own handle",
  instagram: "Publish approved posts from your business account",
  reddit: "Post to your subreddits and feed threads into Discovery",
  meta_ads: "Pull ad results into the learning loop",
  freshsales: "Pull contacts in as leads; approved emails flow back as notes",
  pipedrive: "Pull contacts in as leads; approved emails flow back as notes",
  hubspot: "Pull contacts in as leads; approved emails flow back as notes",
  smartlead: "Send approved sequences from your own warmed sender",
  instantly: "Send approved sequences from your own warmed sender",
  slack: "Get review pings where the team already lives",
  custom: "Proxy any API through the connector service",
};

/**
 * Per-provider setup hint shown when an OAuth provider has no app creds in
 * .env yet (status "needs OAuth app"). Each registers the same Nango callback
 * URL — http://localhost:3050/oauth/callback — on the provider's OAuth app.
 */
const OAUTH_APP_HINTS: Record<string, React.ReactNode> = {
  reddit: (
    <>
      Create a Reddit app (type “web app”, redirect uri{" "}
      <code>http://localhost:3050/oauth/callback</code>) at reddit.com/prefs/apps, then set
      REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in the root .env and restart the API.
    </>
  ),
  linkedin: (
    <>
      Create a LinkedIn app at linkedin.com/developers/apps with the “Sign In with LinkedIn using
      OpenID Connect” + “Share on LinkedIn” products and redirect uri{" "}
      <code>http://localhost:3050/oauth/callback</code>, then set LINKEDIN_CLIENT_ID and
      LINKEDIN_CLIENT_SECRET in the root .env and restart the API.
    </>
  ),
  twitter: (
    <>
      Create an OAuth 2.0 app at developer.x.com with tweet/users/dm scopes and callback uri{" "}
      <code>http://localhost:3050/oauth/callback</code>, then set TWITTER_CLIENT_ID and
      TWITTER_CLIENT_SECRET (the OAuth 2.0 client id/secret) in the root .env and restart the API.
    </>
  ),
  instagram: (
    <>
      Create a Facebook app at developers.facebook.com with the Instagram Graph API (publishing
      needs an Instagram Business/Creator account on a Facebook Page) and callback uri{" "}
      <code>http://localhost:3050/oauth/callback</code>, then set INSTAGRAM_CLIENT_ID and
      INSTAGRAM_CLIENT_SECRET (the Facebook app id/secret) in the root .env and restart the API.
    </>
  ),
};

interface ConnectorsView {
  providers: ProviderView[];
  connections: Connection[];
  fabric: { healthy: boolean; detail?: string };
}

export default function ConnectorsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailSender, setEmailSender] = useState<EmailSender | null>(null);
  const [emailBusy, setEmailBusy] = useState<"save" | "verify" | "refresh" | null>(null);
  const [senderDomain, setSenderDomain] = useState("");
  const [senderLocalPart, setSenderLocalPart] = useState("hello");
  const [senderName, setSenderName] = useState("");
  const [senderReplyTo, setSenderReplyTo] = useState("");

  // connect form state per provider
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testPath, setTestPath] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  // webhook form
  const [hookUrl, setHookUrl] = useState("");
  const [hookSecret, setHookSecret] = useState("");
  const [hookTypes, setHookTypes] = useState<EventType[]>(["draft.approved"]);

  // Content profiles (Sprint 44) — what each social account posts about;
  // injected into drafts that publish from that account. Topics edited as a
  // comma-separated line.
  const [profileDrafts, setProfileDrafts] = useState<
    Record<string, { topics: string; guidance: string }>
  >({});
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const [policyConnectionId, setPolicyConnectionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, wRes, senderRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/webhooks`),
        apiFetch(`/workspaces/${id}/email-sender`),
      ]);
      if (!wsRes.ok || !cRes.ok || !senderRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await cRes.json());
      setWebhooks(await wRes.json());
      const sender = (await senderRes.json()) as EmailSender | null;
      setEmailSender(sender);
      if (sender) {
        setSenderDomain(sender.domain);
        setSenderLocalPart(sender.fromLocalPart);
        setSenderName(sender.fromName);
        setSenderReplyTo(sender.replyTo ?? "");
      }
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEmailSender(event: React.FormEvent) {
    event.preventDefault();
    setEmailBusy("save");
    setError(null);
    try {
      const response = await apiFetch(`/workspaces/${id}/email-sender`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: senderDomain,
          fromLocalPart: senderLocalPart,
          fromName: senderName,
          replyTo: senderReplyTo.trim() || null,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not save sender (${response.status})`);
      }
      setEmailSender(body as EmailSender);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the email sender");
    } finally {
      setEmailBusy(null);
    }
  }

  async function runEmailSenderAction(action: "verify" | "refresh") {
    setEmailBusy(action);
    setError(null);
    try {
      const response = await apiFetch(`/workspaces/${id}/email-sender/${action}`, {
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not ${action} sender (${response.status})`);
      }
      setEmailSender(body as EmailSender);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} the email sender`);
      await load();
    } finally {
      setEmailBusy(null);
    }
  }

  function connectionsFor(providerKey: string): Connection[] {
    return view?.connections.filter((c) => c.providerKey === providerKey) ?? [];
  }

  async function connect(provider: ConnectorProvider) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/connectors/${provider.key}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
          ...(provider.requiresBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(provider.key === "custom" && testPath.trim() ? { testPath: testPath.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setConnectingKey(null);
      setApiKey("");
      setAccessToken("");
      setBaseUrl("");
      setTestPath("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  }

  /** OAuth popup flow: session token from the API → Nango popup → register. */
  async function connectOAuth(provider: ProviderView) {
    setBusy(true);
    setError(null);
    try {
      const result = await authorizeNangoOAuth(async (): Promise<NangoOAuthSession> => {
        const sessionRes = await apiFetch(
          `/workspaces/${id}/connectors/${provider.key}/oauth/session`,
          { method: "POST" },
        );
        const session = await sessionRes.json().catch(() => null);
        if (!sessionRes.ok) {
          throw new Error(oauthSessionErrorMessage(provider.label, sessionRes.status, session));
        }
        return session as NangoOAuthSession;
      });

      const completeRes = await apiFetch(`/workspaces/${id}/connectors/${provider.key}/oauth/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: result.connectionId }),
        },
      );
      const body = await completeRes.json().catch(() => null);
      if (!completeRes.ok) throw new Error(body?.message ?? `API returned ${completeRes.status}`);
      await load();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : `${provider.label} authorization was not completed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(connection: Connection) {
    setBusy(true);
    try {
      const res = await apiFetch(`/workspaces/${id}/connections/${connection.id}/test`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => null);
      setTestResults((t) => ({
        ...t,
        [connection.id]: body ? `${body.ok ? "✓" : "✗"} ${body.detail}` : "test failed",
      }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(connection: Connection) {
    if (!confirm("Disconnect this provider? Credentials are removed from the connector service."))
      return;
    await apiFetch(`/workspaces/${id}/connections/${connection.id}`, { method: "DELETE" });
    await load();
  }

  function profileDraftFor(connection: Connection): { topics: string; guidance: string } {
    return (
      profileDrafts[connection.id] ?? {
        topics: connection.contentProfile.topics.join(", "),
        guidance: connection.contentProfile.guidance,
      }
    );
  }

  async function saveProfile(connection: Connection) {
    const draft = profileDraftFor(connection);
    setProfileBusy(connection.id);
    setError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/connections/${connection.id}/content-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topics: draft.topics.split(",").map((t) => t.trim()).filter(Boolean),
            guidance: draft.guidance,
          }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setProfileDrafts((d) => {
        const { [connection.id]: _saved, ...rest } = d;
        return rest;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save content profile");
    } finally {
      setProfileBusy(null);
    }
  }

  async function addWebhook(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: hookUrl,
          eventTypes: hookTypes,
          ...(hookSecret.trim() ? { secret: hookSecret.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setHookUrl("");
      setHookSecret("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add webhook");
    } finally {
      setBusy(false);
    }
  }

  async function pingWebhook(webhookId: string) {
    setBusy(true);
    try {
      await apiFetch(`/workspaces/${id}/webhooks/${webhookId}/ping`, { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleWebhook(webhook: WebhookSubscription) {
    await apiFetch(`/workspaces/${id}/webhooks/${webhook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !webhook.enabled }),
    });
    await load();
  }

  async function removeWebhook(webhook: WebhookSubscription) {
    if (!confirm("Delete this webhook?")) return;
    await apiFetch(`/workspaces/${id}/webhooks/${webhook.id}`, { method: "DELETE" });
    await load();
  }

  function renderConnectControls(provider: ProviderView) {
    const providerConnections = connectionsFor(provider.key);
    const connectLabel = providerConnections.length > 0 ? "Connect another account" : "Connect";
    const needsOAuthApp = provider.authMode === "oauth" && !provider.oauthConfigured;

    if (connectingKey === provider.key) {
      return (
        <div className="resolve-controls">
          {provider.authMode === "api_key" && (
            <label style={{ flex: 1 }}>
              API key
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Pasted into the connector service, not stored here"
              />
            </label>
          )}
          {provider.authMode === "access_token" && (
            <label style={{ flex: 1 }}>
              Access token
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={
                  provider.key === "meta_ads"
                    ? "System-user token with ads_read (Business settings → System users)"
                    : "Pasted into the connector service, not stored here"
                }
              />
            </label>
          )}
          {provider.requiresBaseUrl && (
            <label style={{ flex: 1 }}>
              Base URL
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  provider.key === "freshsales"
                    ? "https://yourcompany.myfreshworks.com/crm/sales"
                    : "https://api.example.com"
                }
              />
            </label>
          )}
          {provider.key === "custom" && (
            <label>
              Test path
              <Input
                value={testPath}
                onChange={(e) => setTestPath(e.target.value)}
                placeholder="/v1/status"
              />
            </label>
          )}
          <Button
            variant="primary"
            disabled={
              busy ||
              (provider.authMode === "api_key" && !apiKey.trim()) ||
              (provider.authMode === "access_token" && !accessToken.trim()) ||
              (Boolean(provider.requiresBaseUrl) && !baseUrl.trim())
            }
            onClick={() => connect(provider)}
          >
            {connectLabel}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConnectingKey(null)}>
            Cancel
          </Button>
        </div>
      );
    }

    return (
      <div className={styles.cardActions}>
        {provider.authMode !== "oauth" && (
          <Button
            variant={providerConnections.length > 0 ? "secondary" : "primary"}
            size="sm"
            disabled={busy || !view?.fabric.healthy}
            onClick={() => setConnectingKey(provider.key)}
          >
            {connectLabel}
          </Button>
        )}
        {provider.authMode === "oauth" && provider.oauthConfigured && (
          <Button
            variant={providerConnections.length > 0 ? "secondary" : "primary"}
            size="sm"
            disabled={busy || !view?.fabric.healthy}
            onClick={() => connectOAuth(provider)}
          >
            {connectLabel}
          </Button>
        )}
        {needsOAuthApp && OAUTH_APP_HINTS[provider.key] && (
          <details>
            <summary className="link-button" style={{ cursor: "pointer" }}>
              Setup
            </summary>
            <p className={styles.hint}>{OAUTH_APP_HINTS[provider.key]}</p>
          </details>
        )}
      </div>
    );
  }

  function renderProviderCard(provider: ProviderView) {
    const providerConnections = connectionsFor(provider.key);
    const isConnected = providerConnections.some((c) => c.status === "connected");
    const hasError = providerConnections.some((c) => c.status === "error");
    const hasDisconnected = providerConnections.some((c) => c.status === "disconnected");
    const needsOAuthApp = provider.authMode === "oauth" && !provider.oauthConfigured;
    const brand = PROVIDER_BRAND[provider.key];

    return (
      <div key={provider.key} className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.mark}>
            {brand ? (
              <BrandIcon name={brand} size="md" brandColor />
            ) : (
              <Icon name="connect" size="md" />
            )}
          </span>
          <span className={styles.cardName}>{provider.label}</span>
          <Badge
            tone={
              isConnected ? "approved" : hasError ? "rejected" : needsOAuthApp ? "edited" : "neutral"
            }
          >
            {isConnected
              ? "connected"
              : hasError
                ? "error"
                : needsOAuthApp
                  ? "needs OAuth app"
                  : hasDisconnected
                    ? "disconnected"
                    : "not connected"}
          </Badge>
        </div>

        <p className={styles.promise}>{PROVIDER_PROMISE[provider.key] ?? ""}</p>

        {providerConnections.length > 0 && (
          <div className={styles.accounts}>
            {providerConnections.map((connection) => (
              <div
                key={connection.id}
                className={connection.status === "disconnected" ? "excluded" : ""}
              >
                <div className={styles.accountRow}>
                  <Badge
                    tone={
                      connection.status === "connected"
                        ? "approved"
                        : connection.status === "error"
                          ? "rejected"
                          : "neutral"
                    }
                  >
                    {connection.status}
                  </Badge>
                  <span className={styles.accountName}>
                    {connection.externalAccountUrl ? (
                      <a href={connection.externalAccountUrl} target="_blank" rel="noreferrer">
                        {connectionLabel(connection, provider.label)}
                      </a>
                    ) : (
                      connectionLabel(connection, provider.label)
                    )}
                  </span>
                  {connection.externalAccountHandle && (
                    <span className="meta">@{connection.externalAccountHandle}</span>
                  )}
                  {connection.lastCheckedAt && (
                    <span className={styles.accountMeta}>
                      checked {new Date(connection.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {connection.lastError && (
                  <p className={styles.accountError}>{connection.lastError}</p>
                )}
                {testResults[connection.id] && (
                  <p className="section-reason">{testResults[connection.id]}</p>
                )}
                {connection.status !== "disconnected" && (
                  <div className="rating-row" style={{ marginTop: 6 }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => testConnection(connection)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => disconnect(connection)}
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
                {connection.status === "connected" &&
                  provider.categories?.includes("social") && (
                    <details className="outline-preview" style={{ marginTop: 6 }}>
                      <summary
                        className="link-button"
                        style={{ cursor: "pointer", listStyle: "none" }}
                      >
                        Content profile
                        {connection.contentProfile.topics.length > 0 &&
                          ` — covers ${connection.contentProfile.topics.join(", ")}`}
                      </summary>
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        <Input
                          value={profileDraftFor(connection).topics}
                          onChange={(e) =>
                            setProfileDrafts((d) => ({
                              ...d,
                              [connection.id]: {
                                ...profileDraftFor(connection),
                                topics: e.target.value,
                              },
                            }))
                          }
                          placeholder="Topics this account covers, comma-separated…"
                        />
                        <Textarea
                          value={profileDraftFor(connection).guidance}
                          onChange={(e) =>
                            setProfileDrafts((d) => ({
                              ...d,
                              [connection.id]: {
                                ...profileDraftFor(connection),
                                guidance: e.target.value,
                              },
                            }))
                          }
                          placeholder="Account guidelines — injected into every draft that publishes from this account…"
                          rows={3}
                          maxLength={2000}
                        />
                        <div className="editor-actions">
                          <Button
                            variant="primary"
                            type="button"
                            disabled={profileBusy === connection.id}
                            onClick={() => void saveProfile(connection)}
                          >
                            {profileBusy === connection.id ? "Saving…" : "Save profile"}
                          </Button>
                        </div>
                      </div>
                    </details>
                  )}
                {connection.status !== "disconnected" && (
                  <details
                    className={styles.policyDetails}
                    open={policyConnectionId === connection.id}
                    onToggle={(event) =>
                      setPolicyConnectionId((current) =>
                        event.currentTarget.open
                          ? connection.id
                          : current === connection.id
                            ? null
                            : current,
                      )
                    }
                  >
                    <summary>Action permission</summary>
                    {policyConnectionId === connection.id && (
                      <div className={styles.policyEditor}>
                        <ScopedActionPolicy
                          workspaceId={id}
                          scope="connection"
                          scopeId={connection.id}
                          title={`Action permission for ${connectionLabel(
                            connection,
                            provider.label,
                          )}`}
                        />
                      </div>
                    )}
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

        {renderConnectControls(provider)}
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !view) return <EmptyState description="Loading…" />;

  const groups = connectorHubGroups(view.providers);
  const progress = integrationProgress(view.providers, view.connections);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Integrations</h1>
          <p className="subtitle">
            Connect the tools you already use. Credentials stay in a separate connector service,
            never inside Tuezday.
          </p>
        </div>
        <div className={styles.progressRow}>
          <CountBadge
            count={progress.connected}
            max={progress.total}
            label="capabilities connected"
          />
          <span className="meta">capabilities connected</span>
        </div>
      </div>

      {!view.fabric.healthy && (
        <p className="error">
          Connector service offline: {view.fabric.detail ?? "Nango is not reachable."}
        </p>
      )}
      {error && workspace && <p className="error">{error}</p>}

      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h2 className={styles.groupTitle}>Verified email sender</h2>
          <span className={styles.groupUnlocks}>
            Send authorized native email from your own domain
          </span>
        </div>
        <Card className={styles.senderCard}>
          <div className={styles.senderSummary}>
            <div>
              <p className={styles.senderTitle}>
                {emailSender?.fromAddress ?? "Configure a sender identity"}
              </p>
              <p className={styles.hint}>
                Domain verification uses Tuezday&apos;s managed email infrastructure. Your workspace
                stores only the public DNS records needed for verification.
              </p>
            </div>
            <Badge
              tone={
                emailSender?.status === "verified"
                  ? "approved"
                  : emailSender?.status === "failed"
                    ? "rejected"
                    : emailSender?.status === "pending"
                      ? "edited"
                      : "neutral"
              }
            >
              {emailSender?.status.replaceAll("_", " ") ?? "not configured"}
            </Badge>
          </div>

          <form className={styles.senderForm} onSubmit={saveEmailSender}>
            <label>
              From name
              <Input
                value={senderName}
                onChange={(event) => setSenderName(event.target.value)}
                placeholder="Acme"
                maxLength={200}
                required
              />
            </label>
            <label>
              Domain
              <Input
                value={senderDomain}
                onChange={(event) => setSenderDomain(event.target.value)}
                placeholder="example.com"
                required
              />
            </label>
            <label>
              From local part
              <Input
                value={senderLocalPart}
                onChange={(event) => setSenderLocalPart(event.target.value)}
                placeholder="hello"
                maxLength={64}
                required
              />
            </label>
            <label>
              Reply-to address
              <Input
                type="email"
                value={senderReplyTo}
                onChange={(event) => setSenderReplyTo(event.target.value)}
                placeholder="founder@example.com (optional)"
              />
            </label>
            <p className={styles.senderPreview}>
              Preview: {senderName.trim() || "Sender name"} &lt;
              {senderLocalPart.trim() || "hello"}@{senderDomain.trim() || "example.com"}&gt;
            </p>
            <div className={styles.senderActions}>
              <Button
                type="submit"
                variant="primary"
                loading={emailBusy === "save"}
                disabled={!senderName.trim() || !senderDomain.trim() || !senderLocalPart.trim()}
              >
                {emailSender ? "Save sender" : "Configure sender"}
              </Button>
              {emailSender?.providerDomainId && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={emailBusy === "verify"}
                    onClick={() => void runEmailSenderAction("verify")}
                  >
                    Start verification
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={emailBusy === "refresh"}
                    onClick={() => void runEmailSenderAction("refresh")}
                  >
                    Check verification
                  </Button>
                </>
              )}
            </div>
          </form>

          {emailSender?.lastError && (
            <p className={styles.senderError}>
              Verification needs attention: {emailSender.lastError}
            </p>
          )}

          {emailSender && emailSender.dnsRecords.length > 0 && (
            <div className={styles.dnsSection}>
              <div className={styles.dnsHeading}>
                <h3>DNS records</h3>
                {emailSender.lastCheckedAt && (
                  <span className="meta">
                    Last checked {new Date(emailSender.lastCheckedAt).toLocaleString()}
                  </span>
                )}
              </div>
              <div className={styles.dnsTableWrap}>
                <table className={styles.dnsTable}>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Name</th>
                      <th>Value</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emailSender.dnsRecords.map((record) => (
                      <tr key={`${record.type}:${record.name}:${record.value}`}>
                        <td>{record.type}</td>
                        <td><code>{record.name}</code></td>
                        <td><code>{record.value}</code></td>
                        <td>{record.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      </section>

      {groups.map((group) => (
        <section key={group.category} className={styles.group}>
          <div className={styles.groupHead}>
            <h2 className={styles.groupTitle}>{group.title}</h2>
            <span className={styles.groupUnlocks}>{group.unlocks}</span>
          </div>
          <div className={styles.grid}>{group.providers.map(renderProviderCard)}</div>
        </section>
      ))}

      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h2 className={styles.groupTitle}>Webhooks</h2>
          <span className={styles.groupUnlocks}>
            Push approval events to your own automations
          </span>
        </div>
        <Card>
          <form
            className="persona-form"
            style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
            onSubmit={addWebhook}
          >
            <div className="resolve-controls">
              <label style={{ flex: 1 }}>
                Endpoint URL
                <Input
                  value={hookUrl}
                  onChange={(e) => setHookUrl(e.target.value)}
                  placeholder="https://hooks.example.com/tuezday (try webhook.site)"
                />
              </label>
              <label>
                Secret (optional)
                <Input
                  value={hookSecret}
                  onChange={(e) => setHookSecret(e.target.value)}
                  placeholder="for HMAC signatures"
                />
              </label>
            </div>
            <div className="checkbox-row">
              <span className="meta">Events:</span>
              {EVENT_TYPES.filter((t) => t !== "webhook.ping").map((t) => (
                <label key={t} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={hookTypes.includes(t)}
                    onChange={() =>
                      setHookTypes((prev) =>
                        prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                      )
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
            <div className="editor-actions">
              <Button
                variant="primary"
                type="submit"
                disabled={busy || !hookUrl.trim() || hookTypes.length === 0}
              >
                Add webhook
              </Button>
            </div>
          </form>

          {webhooks.length > 0 && (
            <ul className="section-list">
              {webhooks.map((w) => (
                <li key={w.id} className={`section-card ${w.enabled ? "" : "excluded"}`}>
                  <div className="section-head">
                    <Badge tone={w.enabled ? "approved" : "neutral"}>
                      {w.enabled ? "enabled" : "disabled"}
                    </Badge>
                    <span className="section-title">{w.url}</span>
                  </div>
                  <p className="section-reason">{w.eventTypes.join(" · ")}</p>
                  <div className="rating-row" style={{ marginTop: 8 }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => pingWebhook(w.id)}
                    >
                      Ping
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => toggleWebhook(w)}>
                      {w.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => removeWebhook(w)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}
