"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workspace } from "@tuezday/contracts";
import { API_URL, apiFetch, clearToken, getToken } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    router.push("/login");
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <span className="logo">Tuezday</span>
        <span className="tagline">GTM that remembers</span>
        {userLabel && (
          <span className="header-user">
            {userLabel}{" "}
            <button type="button" className="link-button" onClick={logout}>
              Log out
            </button>
          </span>
        )}
      </header>
      <main className="site-main">
      <h1>Workspaces</h1>
      <p className="subtitle">
        Each workspace owns one GTM brain: soul, ICP, voice, history, now.
      </p>

      <div className="create-form">
        <button type="button" onClick={() => router.push("/onboarding")}>
          Start guided setup
        </button>
      </div>

      <details className="quick-create">
        <summary>Quick create (skip onboarding)</summary>
        <form className="create-form" onSubmit={createWorkspace}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New workspace name (e.g. Hexalog)"
            maxLength={100}
          />
          <button type="submit" disabled={submitting || name.trim().length === 0}>
            Create
          </button>
        </form>
      </details>

      {error && <p className="error">{error}</p>}

      {workspaces === null ? (
        <p className="empty">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="empty">No workspaces yet. Create the first one above.</p>
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
                  <span
                    className="link-button"
                    role="link"
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(`/onboarding?workspace=${w.id}`);
                    }}
                  >
                    Resume setup →
                  </span>
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
