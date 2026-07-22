"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workspace } from "@tuezday/contracts";
import { API_URL, apiFetch, clearToken, getToken } from "@/lib/api";
import { Button } from "@/src/components/ui/button";
import styles from "./home.module.css";

export default function HomePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/workspaces");
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      setWorkspaces(await res.json());
      setError(null);
      const me = await apiFetch("/auth/me");
      if (me.ok) {
        const body = await me.json();
        setUserLabel(body.user.name || body.user.email);
      }
    } catch {
      setWorkspaces([]);
      setError(`Could not reach the API at ${API_URL}. Is "npm run dev" running?`);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    void load();
  }, [load, router]);

  // Sprint 36.7: every workspace is created through guided onboarding — there
  // is no manual-create path. A first-time user goes straight into the flow.
  useEffect(() => {
    if (workspaces && workspaces.length === 0) {
      router.push("/onboarding");
    }
  }, [workspaces, router]);

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    router.push("/login");
  }

  return (
    <>
      <header className="site-header">
        <span className="logo">Tuezday</span>
        <span className="tagline">GTM that remembers</span>
        {userLabel && (
          <span className="header-user">
            {userLabel}{" "}
            <Button type="button" variant="tertiary" size="compact" onClick={logout}>
              Log out
            </Button>
          </span>
        )}
      </header>
      <main className="site-main">
        <h1>Workspaces</h1>
        <p className="subtitle">
          Each workspace owns one GTM brain: soul, ICP, voice, history, now.
        </p>

        <div className={styles.actions}>
          <Button variant="primary" onClick={() => router.push("/onboarding")}>
            New workspace
          </Button>
        </div>

        {error && <p className="error">{error}</p>}

        {workspaces === null ? (
          <p className="empty">Loading…</p>
        ) : workspaces.length === 0 ? (
          <p className="empty">Setting up your first workspace…</p>
        ) : (
          <ul className="workspace-list">
            {workspaces.map((w) => (
              <li key={w.id}>
                <Link href={`/workspaces/${w.id}`} className="workspace-card">
                  <span className="name">{w.name}</span>
                  <span className="meta">
                    created {new Date(w.createdAt).toLocaleString()}
                  </span>
                  {w.onboardingStep && w.onboardingStep !== "done" && (
                    <Button
                      variant="tertiary"
                      size="compact"
                      onClick={(e) => {
                        e.preventDefault();
                        router.push(`/onboarding?workspace=${w.id}`);
                      }}
                    >
                      Resume setup →
                    </Button>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
