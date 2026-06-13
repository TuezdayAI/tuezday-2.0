"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface InvitePreview {
  workspaceName: string;
  email: string;
  status: string;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/invites/${token}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setError("This invite link is not valid.");
          return;
        }
        if (res.ok) setInvite(await res.json());
      })
      .catch(() => setError("Could not load the invite. Is the API running?"));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    setAccepting(true);
    setError(null);
    const res = await apiFetch(`/invites/${token}/accept`, { method: "POST" });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setAccepting(false);
      if (body?.error === "email_mismatch") {
        setError(
          `This invite was issued for ${invite?.email}. Log in with that email to accept it.`,
        );
      } else if (res.status === 410) {
        setError("This invite has expired or was revoked. Ask for a new one.");
      } else {
        setError(body?.message ?? "Could not accept the invite.");
      }
      return;
    }
    router.push(`/workspaces/${body.workspaceId}`);
  }

  return (
    <>
      <header className="site-header">
        <span className="logo">Tuezday</span>
        <span className="tagline">GTM that remembers</span>
      </header>
      <main className="site-main">
        <h1>Workspace invite</h1>
        {error && <p className="error">{error}</p>}
        {!invite && !error && <p className="empty">Loading…</p>}
        {invite && (
          <>
            <p className="subtitle">
              You&apos;ve been invited to join <strong>{invite.workspaceName}</strong> (invite for{" "}
              {invite.email}).
            </p>
            {invite.status === "pending" ? (
              <div className="page-actions">
                <button type="button" onClick={accept} disabled={accepting}>
                  {accepting ? "Joining…" : "Accept invite"}
                </button>
              </div>
            ) : (
              <p className="empty">
                {invite.status === "accepted"
                  ? "This invite was already accepted."
                  : "This invite is no longer active."}
              </p>
            )}
          </>
        )}
      </main>
    </>
  );
}
