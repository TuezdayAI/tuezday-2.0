"use client";

import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import styles from "./team.module.css";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { WorkspaceInvite, WorkspaceMember } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

const INVITE_INPUT_ID = "team-invite-email";

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

  function focusInvite() {
    const el = document.getElementById(INVITE_INPUT_ID);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus({ preventScroll: true });
  }

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

  const initialOf = (m: WorkspaceMember) => (m.name || m.email).slice(0, 1).toUpperCase();
  const aloneHere = members !== null && members.length === 1 && members[0]?.userId === myUserId;

  return (
    <>
      {myRole === "owner" && (
        <TopBarActions>
          <Button variant="secondary" size="sm" type="button" onClick={focusInvite}>
            Invite teammate
          </Button>
        </TopBarActions>
      )}

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

      <Card>
        <div className={styles.sectionHead}>
          <Icon name="audience" size="sm" className={styles.sectionIcon} />
          <h2>Members</h2>
          {members !== null && <CountBadge count={members.length} label="members" />}
        </div>
        {members === null ? (
          <EmptyState description="Loading…" />
        ) : aloneHere ? (
          <EmptyState
            icon={<Icon name="audience" size="lg" />}
            title="You're the only one here"
            description="Invite your team — everyone can review and create, and approvals move faster with more eyes."
            primaryAction={
              myRole === "owner" ? (
                <Button variant="primary" type="button" onClick={focusInvite}>
                  Invite your team
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className={styles.memberList}>
            {members.map((m) => (
              <li key={m.userId} className={styles.memberRow}>
                <span className={styles.avatar} aria-hidden="true">
                  {initialOf(m)}
                </span>
                <span className={styles.memberName}>{m.name || m.email}</span>
                <span className={styles.memberEmail}>{m.email}</span>
                <span className={styles.rowEnd}>
                  {m.userId === myUserId && <Badge tone="neutral">you</Badge>}
                  <Badge tone={m.role === "owner" ? "icp" : "neutral"}>{m.role}</Badge>
                  {myRole === "owner" && m.userId !== myUserId && (
                    <Button variant="secondary" size="sm" type="button" onClick={() => remove(m)}>
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {myRole === "owner" && (
        <Card>
          <div className={styles.sectionHead}>
            <Icon name="add" size="sm" className={styles.sectionIcon} />
            <h2>Invite a teammate</h2>
            {invites.length > 0 && <CountBadge count={invites.length} label="pending invites" />}
          </div>
          <p className="subtitle">
            Creating an invite emails the person a join link. The invitee signs up with the same
            email and accepts. You can also copy the link below to share it yourself. Links expire
            in 7 days.
          </p>
          <form className="create-form" onSubmit={sendInvite}>
            <Input
              id={INVITE_INPUT_ID}
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              required
            />
            <Button variant="primary" type="submit" disabled={submitting || !inviteEmail}>
              Create invite
            </Button>
          </form>

          {invites.length > 0 && (
            <ul className={styles.memberList}>
              {invites.map((inv) => (
                <li key={inv.id} className={styles.inviteRow}>
                  <Badge tone="pending">pending</Badge>
                  <span className={styles.memberName}>{inv.email}</span>
                  <span className={styles.inviteExpiry}>
                    expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </span>
                  <span className={styles.rowEnd}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => copyLink(inv)}
                    >
                      Copy link
                    </Button>
                    <Button variant="secondary" size="sm" type="button" onClick={() => revoke(inv)}>
                      Revoke
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <div className={styles.sectionHead}>
          <Icon name="email" size="sm" className={styles.sectionIcon} />
          <h2>Send a test email</h2>
        </div>
        <p className="subtitle">
          Check that transactional email is configured. With a Resend key set it sends for real;
          otherwise it logs to the API console and reports as delivered.
        </p>
        <form className="create-form" onSubmit={sendTestEmail}>
          <Input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="you@company.com"
            required
          />
          <Button variant="primary" type="submit" disabled={testing || !testEmail}>
            {testing ? "Sending…" : "Send test email"}
          </Button>
        </form>
      </Card>
    </>
  );
}
