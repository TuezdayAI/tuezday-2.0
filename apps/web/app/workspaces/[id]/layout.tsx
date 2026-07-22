"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  NAV_SECTIONS,
  WORKSPACE_NAV,
  visibleNavItems,
  type NavItem,
  type NextAction,
  type NextActionState,
  type Workspace,
  type WorkspaceCapabilities,
} from "@tuezday/contracts";
import { apiFetch, clearToken } from "@/lib/api";
import { initAnalytics, identify } from "@/src/analytics";
import { UpgradeModal } from "@/components/upgrade-modal";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { CountBadge, GuideDot } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
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

/**
 * Sprint 48: the Outreach surface lives inside the Audience group, alongside
 * Sequences (S30 launches). The canonical nav lives in @tuezday/contracts;
 * we augment a local copy here rather than edit the shared contract.
 */
const WORKSPACE_NAV_WITH_OUTREACH: NavItem[] = WORKSPACE_NAV.map((item) =>
  item.path === "/outbound" && item.children
    ? {
        ...item,
        children: item.children.some((child) => child.path === "/outreach")
          ? item.children
          : [
              ...item.children.slice(0, 3),
              {
                label: "Outreach",
                path: "/outreach",
                summary: "Always-on email sequences",
                tone: "voice",
                icon: "email",
              },
              ...item.children.slice(3),
            ],
      }
    : item,
);

/** GET /workspaces/:id/next-action response (spec §5.1). */
interface NextActionView {
  state: NextActionState;
  nextAction: NextAction;
  checklist: { done: number; total: number; complete: boolean };
}

/**
 * Spec §5.3: the dot never appears for system-owned or all-clear states, and
 * once the setup checklist completes it only returns for genuinely blocking
 * kinds (review / connect_blocked).
 */
function guideDotAction(view: NextActionView | null): NextAction | null {
  if (!view) return null;
  const { nextAction, checklist } = view;
  if (nextAction.kind === "system_working" || nextAction.kind === "none") return null;
  if (checklist.complete && nextAction.kind !== "review" && nextAction.kind !== "connect_blocked") {
    return null;
  }
  return nextAction;
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [capabilities, setCapabilities] = useState<WorkspaceCapabilities | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [nextActionView, setNextActionView] = useState<NextActionView | null>(null);

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

  // Next action (spec §5.1) — re-fetched on every navigation so the guide dot
  // moves as actions complete. Also drives smart landing (§5.2): the first
  // time a workspace is opened this session, an unfinished setup checklist
  // redirects Home to the next-action page; afterwards Home stays Home.
  useEffect(() => {
    let cancelled = false;
    const base = `/workspaces/${id}`;
    apiFetch(`${base}/next-action`)
      .then((res) => (res.ok ? res.json() : null))
      .then((view: NextActionView | null) => {
        if (cancelled || !view) return;
        setNextActionView(view);
        try {
          const landedKey = `tuezday_landed_${id}`;
          if (!sessionStorage.getItem(landedKey)) {
            sessionStorage.setItem(landedKey, "1");
            if (!view.checklist.complete && view.nextAction.module && pathname === base) {
              router.replace(`${base}${view.nextAction.module}`);
            }
          }
        } catch {
          // sessionStorage unavailable — skip smart landing rather than loop.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, pathname, router]);

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    router.push("/login");
  }

  const base = `/workspaces/${id}`;
  const caps = capabilities ?? EMPTY_CAPABILITIES;
  const navItems = visibleNavItems(WORKSPACE_NAV_WITH_OUTREACH, caps);
  const isActive = (path: string) =>
    path === "" ? pathname === base : pathname.startsWith(`${base}${path}`);
  const isGroupActive = (item: NavItem) =>
    isActive(item.path) || Boolean(item.children?.some((child) => isActive(child.path)));
  const reviewStatus = caps.draftCount > 0 ? `${caps.draftCount} waiting` : "Review clear";
  // Exactly ONE guide dot app-wide (§5.3): it sits on the nav entry whose
  // path equals the next action's module — on the child when the group is
  // expanded, otherwise on the group parent.
  const dotAction = guideDotAction(nextActionView);

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
          {navItems.map((item, itemIndex) => {
            const groupActive = isGroupActive(item);
            const previousItem = navItems[itemIndex - 1];
            const startsSection = previousItem?.section !== item.section;
            const sectionLabel =
              NAV_SECTIONS.find((section) => section.id === item.section)?.label ?? item.section;
            const childrenVisible = Boolean(item.children && groupActive);
            const dotChildMatch =
              childrenVisible && item.children!.some((child) => child.path === dotAction?.module);
            const dotOnParent = Boolean(
              dotAction &&
                !dotChildMatch &&
                (item.path === dotAction.module ||
                  item.children?.some((child) => child.path === dotAction.module)),
            );
            return (
              <section
                key={item.label}
                className={`ws-nav-group ${groupActive ? "active" : ""}`}
                data-tone={item.tone ?? "system"}
                data-section-start={startsSection ? "true" : undefined}
                data-section-label={startsSection ? sectionLabel : undefined}
              >
                <Link
                  className={`ws-nav-item ws-nav-parent ${groupActive ? "active" : ""}`}
                  href={`${base}${item.path}`}
                >
                  {item.icon && <Icon name={item.icon as IconName} size="standard" className="ws-nav-icon" />}
                  <span className="ws-nav-copy">
                    <span className="ws-nav-label">{item.label}</span>
                    {item.summary && <span className="ws-nav-summary">{item.summary}</span>}
                  </span>
                  {dotOnParent && dotAction && <GuideDot reason={dotAction.reason} />}
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
                        {child.icon && <Icon name={child.icon as IconName} size="compact" className="ws-nav-icon" />}
                        <span>{child.label}</span>
                        {dotAction && childrenVisible && child.path === dotAction.module && (
                          <GuideDot reason={dotAction.reason} />
                        )}
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
              <Button type="button" variant="tertiary" size="compact" onClick={logout}>
                Log out
              </Button>
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
