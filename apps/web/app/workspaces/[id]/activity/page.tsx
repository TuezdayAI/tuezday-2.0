"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Card } from "@/src/components/ui/card";
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
        <h2>Event log</h2>
        {events === null ? (
          <p className="meta">Loading…</p>
        ) : events.length === 0 ? (
          <EmptyState description={<>No events yet. Approve a draft or ping a webhook.</>} />
        ) : (
          <ul className="draft-chain">
            {events.map((e) => (
              <li key={e.id}>
                <span className="layer-badge">{e.type}</span>{" "}
                <span className="meta">{new Date(e.createdAt).toLocaleString()}</span>{" "}
                {e.deliveries.map((d, i) => (
                  <span
                    key={i}
                    className={`layer-badge ${d.status === "delivered" ? "state-approved" : "state-rejected"}`}
                    style={{ marginLeft: 6 }}
                  >
                    {d.status === "delivered"
                      ? `delivered (${d.httpStatus})`
                      : `failed${d.httpStatus ? ` (${d.httpStatus})` : ""}`}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
