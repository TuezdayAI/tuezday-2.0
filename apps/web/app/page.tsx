"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Workspace } from "@tuezday/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function HomePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/workspaces`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      setWorkspaces(await res.json());
      setError(null);
    } catch {
      setWorkspaces([]);
      setError(`Could not reach the API at ${API_URL}. Is "npm run dev" running?`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/workspaces`, {
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
      </header>
      <main className="site-main">
      <h1>Workspaces</h1>
      <p className="subtitle">
        Each workspace owns one GTM brain: soul, ICP, voice, history, now.
      </p>

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
              </Link>
            </li>
          ))}
        </ul>
      )}
      </main>
    </>
  );
}
