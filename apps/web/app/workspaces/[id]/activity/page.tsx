"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Card } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon, type IconName } from "@/src/components/ui/icon";
import styles from "./activity.module.css";
import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface EventView {
  id: string;
  type: string;
  payloadJson: string;
  createdAt: number;
  deliveries: { status: string; httpStatus: number | null; error: string | null }[];
}

/** Icon per event type (contracts EVENT_TYPES) — unknown types fall back to "info". */
const EVENT_ICONS: Record<string, IconName> = {
  "draft.approved": "status-approved",
  "draft.rejected": "status-rejected",
  "discovery.item.accepted": "discover",
  "synthesis.accepted": "status-learning",
  "crm.contact.created": "user",
  "crm.note.logged": "edit",
  "ads.synced": "ad",
  "ad.launched": "status-live",
  "post.published": "post",
  "reply.posted": "email",
  "webhook.ping": "connect",
};

export default function ActivityPage() {
  const { id } = useParams<{ id: string }>();

  const [events, setEvents] = useState<EventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/events`);
      if (!res.ok) throw new Error("not found");
      setEvents(await res.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !events) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="subtitle">
            Everything Tuezday did on your behalf — approvals, publishes, discovery, webhooks.
          </p>
        </div>
      </div>

      <Card>
        <div className={styles.sectionHead}>
          <Icon name="info" size="sm" className={styles.sectionIcon} />
          <h2>Event log</h2>
          {events !== null && events.length > 0 && (
            <CountBadge count={events.length} label="events logged" />
          )}
        </div>
        {events === null ? (
          <p className="meta">Loading…</p>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<Icon name="status-approved" size="lg" />}
            title="All quiet"
            description="Nothing has happened yet. As you approve drafts, publish posts, and connect tools, every action lands here — a full audit trail of what Tuezday did on your behalf."
          />
        ) : (
          <ul className={styles.eventList}>
            {events.map((e) => (
              <li key={e.id} className={styles.eventRow}>
                <span className={styles.eventIcon}>
                  <Icon name={EVENT_ICONS[e.type] ?? "info"} size="sm" />
                </span>
                <span className={styles.eventType}>{e.type}</span>
                {e.deliveries.length > 0 && (
                  <span className={styles.deliveries}>
                    {e.deliveries.map((d, i) => (
                      <Badge key={i} tone={d.status === "delivered" ? "approved" : "rejected"}>
                        {d.status === "delivered"
                          ? `delivered (${d.httpStatus})`
                          : `failed${d.httpStatus ? ` (${d.httpStatus})` : ""}`}
                      </Badge>
                    ))}
                  </span>
                )}
                <span className={styles.eventTime}>{new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
