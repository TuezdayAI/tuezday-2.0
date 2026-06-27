"use client";

import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  EVENT_TYPES,
  type Connection,
  type ConnectorProvider,
  type EventType,
  type WebhookSubscription,
  type Workspace,
} from "@tuezday/contracts";

/** The API decorates OAuth providers with whether their app creds are set. */
type ProviderView = ConnectorProvider & { oauthConfigured?: boolean };

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

interface EventView {
  id: string;
  type: string;
  payloadJson: string;
  createdAt: number;
  deliveries: { status: string; httpStatus: number | null; error: string | null }[];
}

export default function ConnectorsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [eventLog, setEventLog] = useState<EventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, wRes, eRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/webhooks`),
        apiFetch(`/workspaces/${id}/events`),
      ]);
      if (!wsRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await cRes.json());
      setWebhooks(await wRes.json());
      setEventLog(await eRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function connectionFor(providerKey: string): Connection | undefined {
    return view?.connections.find((c) => c.providerKey === providerKey);
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
      const sessionRes = await apiFetch(`/workspaces/${id}/connectors/${provider.key}/oauth/session`,
        { method: "POST" },
      );
      const session = await sessionRes.json().catch(() => null);
      if (!sessionRes.ok) throw new Error(session?.message ?? `API returned ${sessionRes.status}`);

      const { default: Nango } = await import("@nangohq/frontend");
      const nango = new Nango({
        host: session.nangoBaseUrl,
        connectSessionToken: session.token,
      });
      const result = await nango.auth(session.integrationKey);

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

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !view) return <EmptyState description="Loading…" />;

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
      </div>

      {!view.fabric.healthy && (
        <p className="error">
          Connector service offline: {view.fabric.detail ?? "Nango is not reachable."}
        </p>
      )}

      <section className="panel">
        <h2>Providers</h2>
        <ul className="section-list">
          {view.providers.map((provider) => {
            const connection = connectionFor(provider.key);
            const isConnected = connection?.status === "connected";
            // An OAuth provider with app creds in .env behaves like any other
            // connectable provider; without them it stays informational.
            const needsOAuthApp = provider.authMode === "oauth" && !provider.oauthConfigured;
            return (
              <li key={provider.key} className="section-card">
                <div className="section-head">
                  <span
                    className={`layer-badge ${
                      isConnected
                        ? "state-approved"
                        : connection?.status === "error"
                          ? "state-rejected"
                          : needsOAuthApp
                            ? "state-edited"
                            : ""
                    }`}
                  >
                    {isConnected
                      ? "connected"
                      : connection?.status === "error"
                        ? "error"
                        : needsOAuthApp
                          ? "needs OAuth app"
                          : "not connected"}
                  </span>
                  <span className="section-title">{provider.label}</span>
                  {connection?.lastCheckedAt && (
                    <span className="section-tokens">
                      checked {new Date(connection.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {connection?.lastError && <p className="error">{connection.lastError}</p>}
                {testResults[connection?.id ?? ""] && (
                  <p className="section-reason">{testResults[connection!.id]}</p>
                )}

                {connectingKey === provider.key ? (
                  <div className="resolve-controls" style={{ marginTop: 10 }}>
                    {provider.authMode === "api_key" && (
                      <label style={{ flex: 1 }}>
                        API key
                        <input
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
                        <input
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
                        <input
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
                        <input
                          value={testPath}
                          onChange={(e) => setTestPath(e.target.value)}
                          placeholder="/v1/status"
                        />
                      </label>
                    )}
                    <button
                      disabled={
                        busy ||
                        (provider.authMode === "api_key" && !apiKey.trim()) ||
                        (provider.authMode === "access_token" && !accessToken.trim()) ||
                        (Boolean(provider.requiresBaseUrl) && !baseUrl.trim())
                      }
                      onClick={() => connect(provider)}
                    >
                      Connect
                    </button>
                    <button className="button-secondary" onClick={() => setConnectingKey(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="rating-row" style={{ marginTop: 8 }}>
                    {provider.authMode !== "oauth" && !isConnected && (
                      <button
                        className="button-secondary"
                        disabled={!view.fabric.healthy}
                        onClick={() => setConnectingKey(provider.key)}
                      >
                        Connect
                      </button>
                    )}
                    {provider.authMode === "oauth" && provider.oauthConfigured && !isConnected && (
                      <button
                        className="button-secondary"
                        disabled={busy || !view.fabric.healthy}
                        onClick={() => connectOAuth(provider)}
                      >
                        {connection?.status === "disconnected" ? "Reconnect" : "Connect"}
                      </button>
                    )}
                    {connection && connection.status !== "disconnected" && (
                      <>
                        <button
                          className="button-secondary"
                          disabled={busy}
                          onClick={() => testConnection(connection)}
                        >
                          Test
                        </button>
                        <button
                          className="button-secondary danger"
                          disabled={busy}
                          onClick={() => disconnect(connection)}
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                    {connection?.status === "disconnected" && provider.authMode !== "oauth" && (
                      <button
                        className="button-secondary"
                        onClick={() => setConnectingKey(provider.key)}
                      >
                        Reconnect
                      </button>
                    )}
                  </div>
                )}
                {needsOAuthApp && OAUTH_APP_HINTS[provider.key] && (
                  <p className="section-reason" style={{ marginTop: 8 }}>
                    {OAUTH_APP_HINTS[provider.key]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>Webhooks</h2>
        <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={addWebhook}>
          <div className="resolve-controls">
            <label style={{ flex: 1 }}>
              Endpoint URL
              <input
                value={hookUrl}
                onChange={(e) => setHookUrl(e.target.value)}
                placeholder="https://hooks.example.com/tuezday (try webhook.site)"
              />
            </label>
            <label>
              Secret (optional)
              <input
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
            <button type="submit" disabled={busy || !hookUrl.trim() || hookTypes.length === 0}>
              Add webhook
            </button>
          </div>
        </form>

        {webhooks.length > 0 && (
          <ul className="section-list">
            {webhooks.map((w) => (
              <li key={w.id} className={`section-card ${w.enabled ? "" : "excluded"}`}>
                <div className="section-head">
                  <span className={`layer-badge ${w.enabled ? "state-approved" : ""}`}>
                    {w.enabled ? "enabled" : "disabled"}
                  </span>
                  <span className="section-title">{w.url}</span>
                </div>
                <p className="section-reason">{w.eventTypes.join(" · ")}</p>
                <div className="rating-row" style={{ marginTop: 8 }}>
                  <button className="button-secondary" disabled={busy} onClick={() => pingWebhook(w.id)}>
                    Ping
                  </button>
                  <button className="button-secondary" onClick={() => toggleWebhook(w)}>
                    {w.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="button-secondary danger" onClick={() => removeWebhook(w)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Event log</h2>
        {eventLog.length === 0 ? (
          <EmptyState description={<>No events yet. Approve a draft or ping a webhook.</>} />
        ) : (
          <ul className="draft-chain">
            {eventLog.map((e) => (
              <li key={e.id}>
                <span className="layer-badge">{e.type}</span>{" "}
                <span className="meta">{new Date(e.createdAt).toLocaleString()}</span>{" "}
                {e.deliveries.map((d, i) => (
                  <span
                    key={i}
                    className={`layer-badge ${d.status === "delivered" ? "state-approved" : "state-rejected"}`}
                    style={{ marginLeft: 6 }}
                  >
                    {d.status === "delivered" ? `delivered (${d.httpStatus})` : `failed${d.httpStatus ? ` (${d.httpStatus})` : ""}`}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
