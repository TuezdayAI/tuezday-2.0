"use client";

import { API_URL, apiFetch } from "@/lib/api";
import { Button } from "@/src/components/ui/button";
import { Input, Select } from "@/src/components/ui/input";
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

      <div style={{ maxWidth: 800 }}>
        <section style={{ marginBottom: "2rem" }}>
          <h2>Add a Channel</h2>
          <form
            onSubmit={addChannel}
            style={{
              display: "flex",
              gap: "1rem",
              alignItems: "center",
              marginTop: "1rem",
              background: "var(--color-bg-subtle)",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
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
              style={{ flex: 1 }}
              disabled={isAdding}
            />
            <Button variant="primary" type="submit" disabled={isAdding || !newTarget.trim()}>
              {isAdding ? "Adding..." : "Add"}
            </Button>
          </form>
          {newType === "telegram" && (
            <p className="help-text" style={{ marginTop: "0.5rem", fontSize: "0.9rem", color: "var(--color-text-dim)" }}>
              To get your Telegram Chat ID, start a conversation with the bot and use a tool like <code>@userinfobot</code>.
            </p>
          )}
        </section>

        <section>
          <h2>Configured Channels</h2>
          {channels.length === 0 ? (
            <p className="empty" style={{ marginTop: "1rem" }}>No channels configured yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
              {channels.map((c) => (
                <li
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "1rem",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    marginBottom: "0.5rem",
                  }}
                >
                  <div>
                    <strong>{c.type === "email" ? "✉️ Email" : "✈️ Telegram"}</strong>
                    <span style={{ marginLeft: "1rem", fontFamily: "monospace" }}>{c.target}</span>
                  </div>
                  <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) => toggleEnabled(c.id, e.target.checked)}
                      />
                      Enabled
                    </label>
                    <Button variant="secondary" size="sm" onClick={() => sendTest(c.id)}>
                      Send Test
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => deleteChannel(c.id)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
