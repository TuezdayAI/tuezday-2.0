"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { Workspace } from "@tuezday/contracts";
import { apiFetch, clearToken } from "@/lib/api";
import { initAnalytics, identify } from "@/src/analytics";

interface NavChild {
  label: string;
  path: string;
}

interface NavItem {
  label: string;
  /** Path suffix under /workspaces/[id]; "" is the workspace home. */
  path: string;
  children?: NavChild[];
}

const NAV: NavItem[] = [
  { label: "Home", path: "" },
  { label: "Insights", path: "/insights" },
  {
    label: "Brain",
    path: "/brain",
    children: [
      { label: "Evidence library", path: "/evidence" },
      { label: "Context inspector", path: "/resolver" },
    ],
  },
  { label: "Discover", path: "/discovery" },
  {
    label: "Create",
    path: "/content",
    children: [{ label: "Playground", path: "/sandbox" }],
  },
  {
    label: "Review",
    path: "/approvals",
    children: [
      { label: "Inbox", path: "/inbox" },
      { label: "Learning", path: "/learning" },
    ],
  },
  {
    label: "Campaigns",
    path: "/campaigns",
    children: [
      { label: "Ads", path: "/ads" },
      { label: "Ad creatives", path: "/ad-creatives" },
      { label: "Launch ads", path: "/ad-launches" },
    ],
  },
  {
    label: "Calendar",
    path: "/calendar",
    children: [
      { label: "Cadence", path: "/cadence" },
      { label: "Automation", path: "/automation" },
    ],
  },
  {
    label: "Audience",
    path: "/outbound",
    children: [
      { label: "Lists & segments", path: "/lists" },
      { label: "Launches", path: "/launches" },
      { label: "CRM", path: "/crm" },
      { label: "PR & media", path: "/pr" },
    ],
  },
  { label: "Integrations", path: "/connectors" },
  { label: "Team", path: "/team" },
];

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/workspaces/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
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
  const isActive = (path: string) =>
    path === "" ? pathname === base : pathname.startsWith(`${base}${path}`);

  return (
    <div className="ws-shell">
      <aside className="ws-sidebar">
        <Link className="ws-logo" href="/">
          Tuezday
        </Link>
        <div className="ws-name">{workspace?.name ?? "…"}</div>
        <nav className="ws-nav">
          {NAV.map((item) => (
            <div key={item.label}>
              <Link
                className={`ws-nav-item ${isActive(item.path) ? "active" : ""}`}
                href={`${base}${item.path}`}
              >
                {item.label}
              </Link>
              {item.children?.map((child) => (
                <Link
                  key={child.path}
                  className={`ws-nav-item ws-nav-child ${isActive(child.path) ? "active" : ""}`}
                  href={`${base}${child.path}`}
                >
                  {child.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="ws-sidebar-foot">
          <Link href="/">← All workspaces</Link>
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
      <main className="ws-content">{children}</main>
    </div>
  );
}
