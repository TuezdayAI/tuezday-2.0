"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Badge } from "@/src/components/ui/badge";
import { apiFetch } from "@/lib/api";
import styles from "./invite.module.css";

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
          setError("This invite link is not valid. Check that you copied the whole link, or ask a workspace owner to send a fresh one.");
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
        setError("This invite has expired or was revoked. Ask a workspace owner for a new one.");
      } else {
        setError(body?.message ?? "Could not accept the invite. Try again in a moment.");
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
        <div className={styles.card}>
          <h1>{invite ? `Join ${invite.workspaceName}` : "Workspace invite"}</h1>
          {error && <p className="error">{error}</p>}
          {!invite && !error && <p className="empty">Loading your invite…</p>}
          {invite && (
            <>
              <div className={styles.badgeRow}>
                <Badge
                  tone={
                    invite.status === "pending"
                      ? "pending"
                      : invite.status === "accepted"
                        ? "approved"
                        : "neutral"
                  }
                >
                  {invite.status}
                </Badge>
                <span className={styles.inviteFor}>invite for {invite.email}</span>
              </div>
              <p className="subtitle">
                You&apos;ve been invited to join <strong>{invite.workspaceName}</strong>. Everyone
                in a workspace can review and create; owners manage the team.
              </p>
              {invite.status === "pending" ? (
                <div className="page-actions">
                  <Button variant="primary" type="button" onClick={accept} disabled={accepting}>
                    {accepting ? "Joining…" : "Accept invite"}
                  </Button>
                </div>
              ) : (
                <p className={styles.help}>
                  {invite.status === "accepted"
                    ? "This invite was already accepted — if that was you, head to your workspaces from the home page."
                    : "This invite is no longer active. Ask a workspace owner to send a fresh one."}
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
