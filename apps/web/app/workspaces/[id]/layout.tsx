"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { Workspace } from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
    children: [{ label: "Learning", path: "/learning" }],
  },
  {
    label: "Campaigns",
    path: "/campaigns",
    children: [
      { label: "Ads", path: "/ads" },
      { label: "Ad creatives", path: "/ad-creatives" },
    ],
  },
  {
    label: "Audience",
    path: "/outbound",
    children: [
      { label: "CRM", path: "/crm" },
      { label: "PR & media", path: "/pr" },
    ],
  },
  { label: "Integrations", path: "/connectors" },
];

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/workspaces/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

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
        </div>
      </aside>
      <main className="ws-content">{children}</main>
    </div>
  );
}
