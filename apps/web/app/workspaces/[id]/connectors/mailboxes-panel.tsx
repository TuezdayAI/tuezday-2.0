"use client";

// Sprint 47 — Outreach mailboxes panel on the Integrations hub. A connected
// Gmail connection becomes a mailbox (the outreach send identity + reply
// source). Sending-window controls are deliberately absent this sprint: the
// config is stored server-side and enforced by the Sprint 48 scheduler.

import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import { SettingsModal } from "@/src/components/ui/settings-modal";
import { toast } from "@/src/components/ui/toast";
import styles from "./connectors.module.css";

import { apiFetch } from "@/lib/api";
import { connectionLabel } from "@/lib/persona-social-routing";

import { useCallback, useEffect, useState } from "react";
import type { Connection, MailboxWithUsage, Persona } from "@tuezday/contracts";
import { MAILBOX_MAX_DAILY_CAP } from "@tuezday/contracts";

interface MailboxSettingsForm {
  displayName: string;
  replyTo: string;
  signature: string;
  dailyCap: string;
  defaultPersonaId: string;
}

export function MailboxesPanel({
  workspaceId: id,
  gmailConnections,
}: {
  workspaceId: string;
  /** All gmail connector rows in the workspace (any status). */
  gmailConnections: Connection[];
}) {
  const [mailboxes, setMailboxes] = useState<MailboxWithUsage[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MailboxWithUsage | null>(null);
  const [form, setForm] = useState<MailboxSettingsForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mRes, pRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/mailboxes`),
        apiFetch(`/workspaces/${id}/personas`),
      ]);
      if (mRes.ok) {
        setMailboxes((await mRes.json()) as MailboxWithUsage[]);
        setError(null);
      } else if (mRes.status !== 404) {
        const body = await mRes.json().catch(() => null);
        setError(body?.message ?? `Could not load mailboxes (${mRes.status})`);
      }
      if (pRes.ok) setPersonas((await pRes.json()) as Persona[]);
    } catch {
      setError("Could not load mailboxes. Is the API running?");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, gmailConnections]);

  const activeMailboxConnectionIds = new Set(
    mailboxes.filter((m) => m.status !== "disconnected").map((m) => m.connectionId),
  );
  const creatableConnections = gmailConnections.filter(
    (c) => c.status === "connected" && !activeMailboxConnectionIds.has(c.id),
  );

  // Nothing to show until Gmail is in the picture.
  if (gmailConnections.length === 0 && mailboxes.length === 0) return null;

  async function createMailbox(connection: Connection) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/mailboxes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      toast("Mailbox connected");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the mailbox");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectMailbox(mailbox: MailboxWithUsage) {
    if (
      !confirm(
        `Disconnect the mailbox ${mailbox.address}? Outreach stops sending from it; the Gmail connection itself stays.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/mailboxes/${mailbox.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect the mailbox");
    } finally {
      setBusy(false);
    }
  }

  function openSettings(mailbox: MailboxWithUsage) {
    setEditing(mailbox);
    setForm({
      displayName: mailbox.displayName,
      replyTo: mailbox.replyTo ?? "",
      signature: mailbox.signature,
      dailyCap: String(mailbox.dailyCap),
      defaultPersonaId: mailbox.defaultPersonaId ?? "",
    });
  }

  const parsedCap = form ? Number.parseInt(form.dailyCap, 10) : NaN;
  const capValid =
    Number.isInteger(parsedCap) && parsedCap >= 1 && parsedCap <= MAILBOX_MAX_DAILY_CAP;

  async function saveSettings() {
    if (!editing || !form || !capValid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/mailboxes/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.displayName,
          replyTo: form.replyTo.trim() || null,
          signature: form.signature,
          dailyCap: parsedCap,
          defaultPersonaId: form.defaultPersonaId || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setEditing(null);
      setForm(null);
      toast("Settings saved");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save mailbox settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <h2 className={styles.groupTitle}>Outreach mailboxes</h2>
        <span className={styles.groupUnlocks}>
          Outreach sends from your real mailbox; replies come back into the inbox
        </span>
      </div>
      <Card className={styles.senderCard}>
        {error && <p className={styles.accountError}>{error}</p>}

        {mailboxes.length === 0 && creatableConnections.length === 0 && (
          <p className={styles.hint}>
            Connect Gmail under Outbound above, then turn the connection into an outreach mailbox
            here.
          </p>
        )}

        {mailboxes.length > 0 && (
          <div className={styles.accounts} style={{ borderTop: "none", paddingTop: 0 }}>
            {mailboxes.map((mailbox) => (
              <div
                key={mailbox.id}
                className={mailbox.status === "disconnected" ? "excluded" : ""}
              >
                <div className={styles.accountRow}>
                  <Icon name="email" size="compact" />
                  <span className={styles.accountName}>
                    {mailbox.displayName
                      ? `${mailbox.displayName} <${mailbox.address}>`
                      : mailbox.address}
                  </span>
                  <Badge
                    tone={
                      mailbox.status === "connected"
                        ? "approved"
                        : mailbox.status === "error"
                          ? "rejected"
                          : "neutral"
                    }
                  >
                    {mailbox.status}
                  </Badge>
                  <span className={styles.accountMeta}>
                    <CountBadge
                      count={mailbox.sentToday}
                      max={mailbox.dailyCap}
                      label="emails sent today against the daily cap"
                    />{" "}
                    sent today
                  </span>
                </div>
                {mailbox.lastError && (
                  <p className={styles.accountError}>{mailbox.lastError}</p>
                )}
                {mailbox.status !== "disconnected" && (
                  <div className="rating-row" style={{ marginTop: 6 }}>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busy}
                      onClick={() => openSettings(mailbox)}
                    >
                      <Icon name="module-settings" size="compact" /> Settings
                    </Button>
                    <Button
                      variant="danger"
                      size="compact"
                      disabled={busy}
                      onClick={() => void disconnectMailbox(mailbox)}
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {creatableConnections.length > 0 && (
          <div className={styles.cardActions}>
            {creatableConnections.map((connection) => (
              <Button
                key={connection.id}
                variant={mailboxes.length === 0 ? "primary" : "secondary"}
                size="compact"
                disabled={busy}
                onClick={() => void createMailbox(connection)}
              >
                <Icon name="add" size="compact" /> Use {connectionLabel(connection, "Gmail")} as
                outreach mailbox
              </Button>
            ))}
          </div>
        )}
      </Card>

      <SettingsModal
        title={`Mailbox settings — ${editing?.address ?? ""}`}
        open={editing !== null && form !== null}
        onClose={() => {
          setEditing(null);
          setForm(null);
        }}
        onSave={() => void saveSettings()}
        saving={saving}
      >
        {form && (
          <div className={styles.senderForm}>
            <label>
              From name
              <Input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="How recipients see you"
                maxLength={200}
              />
            </label>
            <label>
              Reply-to address
              <Input
                type="email"
                value={form.replyTo}
                onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
                placeholder="Blank = the mailbox itself"
              />
            </label>
            <label>
              Daily cap
              <Input
                type="number"
                min={1}
                max={MAILBOX_MAX_DAILY_CAP}
                value={form.dailyCap}
                onChange={(e) => setForm({ ...form, dailyCap: e.target.value })}
              />
            </label>
            <label>
              Default persona
              <Select
                value={form.defaultPersonaId}
                onChange={(e) => setForm({ ...form, defaultPersonaId: e.target.value })}
              >
                <option value="">(none — org voice)</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              Signature
              <Textarea
                value={form.signature}
                onChange={(e) => setForm({ ...form, signature: e.target.value })}
                placeholder="Appended to every email sent from this mailbox"
                rows={4}
                maxLength={2000}
              />
            </label>
            {!capValid && (
              <p className={styles.accountError} style={{ gridColumn: "1 / -1" }}>
                Daily cap must be a whole number between 1 and {MAILBOX_MAX_DAILY_CAP}.
              </p>
            )}
            <p className={styles.hint} style={{ gridColumn: "1 / -1" }}>
              Sending windows arrive with sequences (Sprint 48) — the cap is enforced on every
              send today.
            </p>
          </div>
        )}
      </SettingsModal>
    </section>
  );
}
