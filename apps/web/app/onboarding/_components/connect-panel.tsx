"use client";

import { useCallback, useEffect, useState } from "react";
import {
  onboardingReadingProgress,
  type BrandProfileStatus,
  type Connection,
  type ConnectorProvider,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  authorizeNangoOAuth,
  oauthSessionErrorMessage,
  type NangoOAuthSession,
} from "@/lib/nango-oauth";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import type { WizardPanelProps } from "./types";
import "./connect-panel.css";

/** The API decorates OAuth providers with whether their app creds are set. */
type ProviderView = ConnectorProvider & { oauthConfigured?: boolean };

interface ConnectorsView {
  providers: ProviderView[];
  connections: Connection[];
  fabric: { healthy: boolean; detail?: string };
}

type ProfileStatus = BrandProfileStatus | "none";

/** The social cards, in display order. `twitter` is labelled "X". Reddit's
 * OAuth app ships configured, so it is the one connectable out of the box. */
const SOCIAL_CARDS = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "twitter", label: "X" },
  { key: "instagram", label: "Instagram" },
  { key: "reddit", label: "Reddit" },
] as const;

function isSocialKey(key: string): boolean {
  return SOCIAL_CARDS.some((c) => c.key === key);
}

/**
 * Step 3 (Sprint 36.5): connect socials + the "Tuezday is reading…" strip.
 * The OAuth popup flow is the connectors page's, verbatim: session token from
 * the API → Nango popup via @/lib/nango-oauth → complete → refresh.
 */
export function ConnectPanel({ workspaceId, onContinue, onError }: WizardPanelProps) {
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>("none");
  const [retrying, setRetrying] = useState(false);
  const [continuing, setContinuing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/connectors`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      setView((await res.json()) as ConnectorsView);
    } catch {
      onError('Could not load your connectors. Is "npm run dev" running?');
    }
  }, [workspaceId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the brand-profile run while it is in flight. Transient poll failures
  // are ignored (never clobber the wizard error line every 2.5s).
  const fetchProfile = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/brand-profile`);
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { status?: ProfileStatus } | null;
      if (body?.status) setProfileStatus(body.status);
    } catch {
      // best-effort poll; the next tick retries
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (profileStatus !== "scraping" && profileStatus !== "extracting") return;
    const timer = setInterval(() => void fetchProfile(), 2500);
    return () => clearInterval(timer);
  }, [profileStatus, fetchProfile]);

  const connections = view?.connections ?? [];
  const connectedCount = connections.filter(
    (c) => isSocialKey(c.providerKey) && c.status === "connected",
  ).length;
  const progress = onboardingReadingProgress(profileStatus, connectedCount);
  const reading = profileStatus === "scraping" || profileStatus === "extracting";

  function connectionsFor(providerKey: string): Connection[] {
    return connections.filter((c) => c.providerKey === providerKey);
  }

  /** OAuth popup flow: session token from the API → Nango popup → complete. */
  async function connectOAuth(provider: ProviderView) {
    setBusyKey(provider.key);
    onError(null);
    try {
      const result = await authorizeNangoOAuth(async (): Promise<NangoOAuthSession> => {
        const sessionRes = await apiFetch(
          `/workspaces/${workspaceId}/connectors/${provider.key}/oauth/session`,
          { method: "POST" },
        );
        const session = await sessionRes.json().catch(() => null);
        if (!sessionRes.ok) {
          throw new Error(oauthSessionErrorMessage(provider.label, sessionRes.status, session));
        }
        return session as NangoOAuthSession;
      });

      const completeRes = await apiFetch(
        `/workspaces/${workspaceId}/connectors/${provider.key}/oauth/complete`,
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
      onError(
        err instanceof Error && err.message
          ? err.message
          : `${provider.label} authorization was not completed.`,
      );
    } finally {
      setBusyKey(null);
    }
  }

  /** Failed read → re-run the scrape/extract and resume the progress strip. */
  async function retryProfile() {
    setRetrying(true);
    onError(null);
    setProfileStatus("scraping"); // restarts polling while the awaited re-run flows
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/brand-profile/refresh`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as
        | { status?: ProfileStatus; message?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setProfileStatus(body?.status ?? "none");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not retry reading your site");
      void fetchProfile();
    } finally {
      setRetrying(false);
    }
  }

  async function handleContinue() {
    setContinuing(true);
    try {
      await onContinue(); // the shell surfaces the min-1 gate's 409 message
    } finally {
      setContinuing(false);
    }
  }

  return (
    <Card className="ob-panel">
      <h1>Connect your socials</h1>
      <p className="subtitle">
        Connect at least one account so Tuezday can learn your voice from what you already post.
      </p>

      <ul className="ob-connect-cards">
        {SOCIAL_CARDS.map((card) => {
          const provider = view?.providers.find((p) => p.key === card.key);
          const providerConnections = connectionsFor(card.key);
          const connected = providerConnections.filter((c) => c.status === "connected");
          const isConnected = connected.length > 0;
          const needsOAuthApp =
            provider !== undefined && provider.authMode === "oauth" && !provider.oauthConfigured;
          const canConnect =
            provider !== undefined && !needsOAuthApp && view !== null && view.fabric.healthy;
          return (
            <li
              key={card.key}
              className={`ob-connect-card ${needsOAuthApp ? "ob-connect-card-muted" : ""}`}
            >
              <div className="ob-connect-body">
                <span className="ob-connect-name">{card.label}</span>
                {isConnected && connected[0]?.externalAccountHandle && (
                  <span className="ob-connect-handle">@{connected[0].externalAccountHandle}</span>
                )}
                {needsOAuthApp && (
                  <span className="ob-connect-note">
                    OAuth app not configured in .env — see Integrations for setup.
                  </span>
                )}
                {!needsOAuthApp && view !== null && !view.fabric.healthy && (
                  <span className="ob-connect-note">
                    Connector service offline: {view.fabric.detail ?? "Nango is not reachable."}
                  </span>
                )}
              </div>
              {isConnected ? (
                <span className="layer-badge state-approved">connected</span>
              ) : needsOAuthApp ? (
                <span className="layer-badge state-edited">needs setup</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyKey !== null || !canConnect}
                  onClick={() => provider && void connectOAuth(provider)}
                >
                  {busyKey === card.key ? "Connecting…" : "Connect"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="ob-reading">
        <div className="ob-reading-head">
          <span className="ob-reading-title">Tuezday is reading…</span>
          <span className="ob-reading-label">{progress.label}</span>
        </div>
        <div
          className="ob-reading-track"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Tuezday is reading your website"
        >
          <div
            className={`ob-reading-fill ${reading ? "is-reading" : ""} ${
              profileStatus === "failed" ? "is-failed" : ""
            }`}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        {profileStatus === "failed" && (
          <div>
            <Button variant="ghost" size="sm" disabled={retrying} onClick={retryProfile}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )}
      </div>

      <div className="ob-actions">
        <span className={`meta ${view !== null && connectedCount === 0 ? "ob-gate-hint" : ""}`}>
          {view !== null && connectedCount === 0
            ? "At least one connection required — connect an account above to continue"
            : "At least one connection required"}
        </span>
        <Button variant="primary" disabled={continuing} onClick={handleContinue}>
          {continuing ? "Continuing…" : "Continue"}
        </Button>
      </div>
    </Card>
  );
}
