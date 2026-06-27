"use client";

import { EmptyState } from "@/src/components/empty-state";


import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { WorkspaceInvite, WorkspaceMember } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

export default function TeamPage() {
  const { id } = useParams<{ id: string }>();
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<"owner" | "member" | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const meRes = await apiFetch("/auth/me");
      if (meRes.ok) {
        const me = await meRes.json();
        setMyUserId(me.user.id);
        const membership = me.memberships.find(
          (m: { workspaceId: string }) => m.workspaceId === id,
        );
        setMyRole(membership?.role ?? null);

        const membersRes = await apiFetch(`/workspaces/${id}/members`);
        if (membersRes.ok) setMembers(await membersRes.json());

        if (membership?.role === "owner") {
          const invitesRes = await apiFetch(`/workspaces/${id}/invites`);
          if (invitesRes.ok) setInvites(await invitesRes.json());
        }
      }
      setError(null);
    } catch {
      setError("Could not load the team. Is the API running?");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const res = await apiFetch(`/workspaces/${id}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    const body = await res.json().catch(() => null);
    setSubmitting(false);
    if (!res.ok) {
      setError(body?.message ?? "Could not create the invite.");
      return;
    }
    setInviteEmail("");
    setNotice(`Invite created for ${body.email} — we emailed them the link (copy it below as a backup).`);
    await load();
  }

  async function sendTestEmail(e: React.FormEvent) {
    e.preventDefault();
    setTesting(true);
    setError(null);
    setNotice(null);
    const res = await apiFetch(`/workspaces/${id}/mail/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: testEmail }),
    });
    const body = await res.json().catch(() => null);
    setTesting(false);
    if (!res.ok) {
      setError(body?.message ?? "Could not send the test email.");
      return;
    }
    setNotice(
      body?.delivered
        ? `Test email sent to ${testEmail}. ${body.detail ?? ""}`
        : `The mailer did not deliver: ${body?.detail ?? "unknown error"}`,
    );
  }

  async function copyLink(invite: WorkspaceInvite) {
    const link = `${window.location.origin}/invites/${invite.token}`;
    await navigator.clipboard.writeText(link);
    setNotice(`Invite link for ${invite.email} copied to clipboard.`);
  }

  async function revoke(invite: WorkspaceInvite) {
    await apiFetch(`/workspaces/${id}/invites/${invite.id}`, { method: "DELETE" });
    await load();
  }

  async function remove(member: WorkspaceMember) {
    if (!window.confirm(`Remove ${member.name || member.email} from this workspace?`)) return;
    const res = await apiFetch(`/workspaces/${id}/members/${member.userId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.message ?? "Could not remove that member.");
      return;
    }
    await load();
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <p className="subtitle">
            Who can work in this workspace. Owners manage the team; everyone reviews and creates.
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <EmptyState description={<>{notice}</>} />}

      <section className="panel">
        <h2>Members</h2>
        {members === null ? (
          <EmptyState description="Loading…" />
        ) : (
          <ul className="checklist">
            {members.map((m) => (
              <li key={m.userId} className="checklist-item">
                <span>
                  <strong>{m.name || m.email}</strong>{" "}
                  <span className="doc-status">
                    {m.email} · {m.role}
                    {m.userId === myUserId ? " · you" : ""}
                  </span>
                </span>
                {myRole === "owner" && m.userId !== myUserId && (
                  <button type="button" className="button-secondary" onClick={() => remove(m)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {myRole === "owner" && (
        <section className="panel">
          <h2>Invite a teammate</h2>
          <p className="subtitle">
            Creating an invite emails the person a join link. The invitee signs up with the same
            email and accepts. You can also copy the link below to share it yourself. Links expire
            in 7 days.
          </p>
          <form className="create-form" onSubmit={sendInvite}>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              required
            />
            <button type="submit" disabled={submitting || !inviteEmail}>
              Create invite
            </button>
          </form>

          {invites.length > 0 && (
            <ul className="checklist">
              {invites.map((inv) => (
                <li key={inv.id} className="checklist-item">
                  <span>
                    <strong>{inv.email}</strong>{" "}
                    <span className="doc-status">
                      expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="page-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => copyLink(inv)}
                    >
                      Copy link
                    </button>
                    <button type="button" className="button-secondary" onClick={() => revoke(inv)}>
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Send a test email</h2>
        <p className="subtitle">
          Check that transactional email is configured. With a Resend key set it sends for real;
          otherwise it logs to the API console and reports as delivered.
        </p>
        <form className="create-form" onSubmit={sendTestEmail}>
          <input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="you@company.com"
            required
          />
          <button type="submit" disabled={testing || !testEmail}>
            {testing ? "Sending…" : "Send test email"}
          </button>
        </form>
      </section>
    </>
  );
}
