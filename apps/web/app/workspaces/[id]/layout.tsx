"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  WORKSPACE_NAV,
  visibleNavItems,
  type NavItem,
  type Workspace,
  type WorkspaceCapabilities,
} from "@tuezday/contracts";
import { apiFetch, clearToken } from "@/lib/api";
import { initAnalytics, identify } from "@/src/analytics";
import { UpgradeModal } from "@/components/upgrade-modal";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { CountBadge } from "@/src/components/ui/badge";
import { TopBar } from "@/src/components/top-bar";
import { Toaster } from "@/src/components/ui/toast";

const EMPTY_CAPABILITIES: WorkspaceCapabilities = {
  hasAds: false,
  hasInsights: false,
  hasCrm: false,
  hasConnections: false,
  draftCount: 0,
  generationCount: 0,
};

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [capabilities, setCapabilities] = useState<WorkspaceCapabilities | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/workspaces/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
      })
      .catch(() => {});

    apiFetch(`/workspaces/${id}/capabilities`)
      .then((res) => (res.ok ? res.json() : null))
      .then((caps) => {
        if (!cancelled) setCapabilities(caps);
      })
      .catch(() => {});

    apiFetch(`/workspaces/${id}/analytics-optout`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          initAnalytics(id, data.optOut);
        }
      })
      .catch(() => {});

    apiFetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => {
        if (!cancelled && me) {
          setUserLabel(me.user.name || me.user.email);
          identify(me.user.id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    router.push("/login");
  }

  const base = `/workspaces/${id}`;
  const caps = capabilities ?? EMPTY_CAPABILITIES;
  const navItems = visibleNavItems(WORKSPACE_NAV, caps);
  const isActive = (path: string) =>
    path === "" ? pathname === base : pathname.startsWith(`${base}${path}`);
  const isGroupActive = (item: NavItem) =>
    isActive(item.path) || Boolean(item.children?.some((child) => isActive(child.path)));
  const reviewStatus = caps.draftCount > 0 ? `${caps.draftCount} waiting` : "Review clear";

  return (
    <div className="ws-shell">
      <aside className="ws-sidebar">
        <div className="ws-brand-block">
          <Link className="ws-logo" href="/">
            <span className="ws-mark" aria-hidden="true">
              t
            </span>
            <span>Tuezday</span>
          </Link>
          <div className="ws-kicker">GTM control room</div>
        </div>

        <div className="ws-workspace-card">
          <div className="ws-workspace-label">Workspace</div>
          <div className="ws-name">{workspace?.name ?? "Loading"}</div>
          <div className="ws-health-row">
            <span>{reviewStatus}</span>
            <span>{caps.generationCount} outputs</span>
          </div>
        </div>

        <nav className="ws-nav" aria-label="Workspace navigation">
          {navItems.map((item) => {
            const groupActive = isGroupActive(item);
            return (
              <section
                key={item.label}
                className={`ws-nav-group ${groupActive ? "active" : ""}`}
                data-tone={item.tone ?? "system"}
              >
                <Link
                  className={`ws-nav-item ws-nav-parent ${groupActive ? "active" : ""}`}
                  href={`${base}${item.path}`}
                >
                  {item.icon && <Icon name={item.icon as IconName} size="md" className="ws-nav-icon" />}
                  <span className="ws-nav-copy">
                    <span className="ws-nav-label">{item.label}</span>
                    {item.summary && <span className="ws-nav-summary">{item.summary}</span>}
                  </span>
                </Link>

                {item.children && groupActive && (
                  <div className="ws-nav-children">
                    {item.children.map((child) => (
                      <Link
                        key={child.path}
                        className={`ws-nav-item ws-nav-child ${
                          isActive(child.path) ? "active" : ""
                        }`}
                        href={`${base}${child.path}`}
                        data-tone={child.tone ?? item.tone ?? "system"}
                      >
                        {child.icon && <Icon name={child.icon as IconName} size="sm" className="ws-nav-icon" />}
                        <span>{child.label}</span>
                        {child.path === "/connectors" &&
                          caps.integrationsTotal != null &&
                          caps.integrationsConnected != null && (
                            <CountBadge
                              count={caps.integrationsConnected}
                              max={caps.integrationsTotal}
                              label="capabilities connected"
                              style={{ marginLeft: "auto" }}
                            />
                          )}
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </nav>

        <div className="ws-sidebar-foot">
          <Link href="/">{"<-"} All workspaces</Link>
          {userLabel && (
            <div className="ws-user">
              <span>{userLabel}</span>
              <button type="button" className="link-button" onClick={logout}>
                Log out
              </button>
            </div>
          )}
        </div>
      </aside>
      <div className="ws-content-col">
        <TopBar
          workspaceName={workspace?.name ?? null}
          reviewCount={caps.draftCount}
          userLabel={userLabel}
        />
        <main className="ws-content">{children}</main>
      </div>
      <UpgradeModal />
      <Toaster />
    </div>
  );
}
