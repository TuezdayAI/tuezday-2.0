"use client";

import { API_URL, apiFetch } from "@/lib/api";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Input, Select } from "@/src/components/ui/input";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import styles from "./notifications.module.css";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { Workspace } from "@tuezday/contracts";

type NotificationChannelType = "telegram" | "email";

interface NotificationChannel {
  id: string;
  workspaceId: string;
  type: NotificationChannelType;
  target: string;
  enabled: boolean;
  createdAt: number;
}

export default function NotificationsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New channel form
  const [newType, setNewType] = useState<NotificationChannelType>("email");
  const [newTarget, setNewTarget] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, chRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/notifications`),
      ]);
      if (!wsRes.ok || !chRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setChannels(await chRes.json());
      setError(null);
    } catch {
      setError(`Could not load notifications from ${API_URL}.`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newTarget.trim()) return;
    setIsAdding(true);
    try {
      const res = await apiFetch(`/workspaces/${id}/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, target: newTarget.trim(), enabled: true }),
      });
      if (!res.ok) throw new Error("Failed to add channel");
      setNewTarget("");
      await load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsAdding(false);
    }
  }

  async function toggleEnabled(channelId: string, enabled: boolean) {
    try {
      await apiFetch(`/workspaces/${id}/notifications/${channelId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function deleteChannel(channelId: string) {
    if (!confirm("Remove this notification channel?")) return;
    try {
      await apiFetch(`/workspaces/${id}/notifications/${channelId}`, {
        method: "DELETE",
      });
      await load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function sendTest(channelId: string) {
    try {
      const res = await apiFetch(`/workspaces/${id}/notifications/${channelId}/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to send test");
      alert("Test sent successfully!");
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!workspace || !channels) return <p className="empty">Loading…</p>;

  const enabledCount = channels.filter((c) => c.enabled).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Notifications</h1>
          <p className="subtitle">
            Configure where you receive approval requests when a new draft hits the gate.
          </p>
        </div>
      </div>

      <div className={styles.column}>
        <section>
          <div className={styles.sectionHead}>
            <Icon name="add" size="sm" className={styles.sectionIcon} />
            <h2>Add a channel</h2>
          </div>
          <form onSubmit={addChannel} className={styles.addForm}>
            <Select
              value={newType}
              onChange={(e) => setNewType(e.target.value as NotificationChannelType)}
            >
              <option value="email">Email</option>
              <option value="telegram">Telegram</option>
            </Select>
            <Input
              type="text"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder={newType === "email" ? "founder@example.com" : "Telegram Chat ID"}
              className={styles.addTarget}
              disabled={isAdding}
            />
            <Button variant="primary" type="submit" disabled={isAdding || !newTarget.trim()}>
              {isAdding ? "Adding…" : "Add"}
            </Button>
          </form>
          {newType === "telegram" && (
            <p className={styles.help}>
              To get your Telegram Chat ID, start a conversation with the bot and use a tool like{" "}
              <code>@userinfobot</code>.
            </p>
          )}
        </section>

        <section>
          <div className={styles.sectionHead}>
            <Icon name="notification" size="sm" className={styles.sectionIcon} />
            <h2>Configured channels</h2>
            {channels.length > 0 && (
              <CountBadge count={enabledCount} max={channels.length} label="channels enabled" />
            )}
          </div>
          {channels.length === 0 ? (
            <EmptyState
              icon={<Icon name="notification" size="lg" />}
              title="Nothing to catch up on"
              description="No channels yet — add your email or Telegram above and Tuezday will ping you the moment a draft needs review. Until then, the approval queue has you covered."
            />
          ) : (
            <ul className={styles.channelList}>
              {channels.map((c) => (
                <li key={c.id} className={styles.channelRow}>
                  <span className={styles.channelIcon}>
                    <Icon name={c.type === "email" ? "email" : "notification"} size="sm" />
                  </span>
                  <span className={styles.channelType}>
                    {c.type === "email" ? "Email" : "Telegram"}
                  </span>
                  <span className={styles.channelTarget}>{c.target}</span>
                  <Badge tone={c.enabled ? "approved" : "neutral"}>
                    {c.enabled ? "on" : "off"}
                  </Badge>
                  <span className={styles.rowEnd}>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) => toggleEnabled(c.id, e.target.checked)}
                      />
                      Enabled
                    </label>
                    <Button variant="secondary" size="sm" onClick={() => sendTest(c.id)}>
                      Send test
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => deleteChannel(c.id)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
