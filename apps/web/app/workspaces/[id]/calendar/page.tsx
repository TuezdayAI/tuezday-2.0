"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { Select } from "@/src/components/ui/input";
import styles from "./calendar.module.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  type CalendarEntry,
  type CalendarEntryStatus,
  type Channel,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const STATUS_TONE: Record<CalendarEntryStatus, "draft" | "pending" | "approved" | "rejected"> = {
  open: "draft",
  scheduled: "pending",
  published: "approved",
  failed: "rejected",
};

function entryIcon(e: CalendarEntry): IconName {
  if (e.kind === "slot") return "calendar";
  if (e.channel === "email") return "email";
  if (e.channel === "ads") return "ad";
  if (e.channel === "web") return "blog";
  return "post";
}

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day)); // back to Monday
  return date;
}

export default function CalendarPage() {
  const { id } = useParams<{ id: string }>();
  // Initialized on the client only — the server can't know the viewer's week,
  // and rendering dates during SSR caused hydration mismatches.
  const [weekStart, setWeekStart] = useState<Date | null>(null);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [channelFilter, setChannelFilter] = useState<Channel | "all">("all");
  const [showOpen, setShowOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWeekStart((w) => w ?? startOfWeek(new Date()));
  }, []);

  const weekEnd = useMemo(
    () => (weekStart ? new Date(weekStart.getTime() + 7 * DAY_MS) : null),
    [weekStart],
  );

  const load = useCallback(async () => {
    if (!weekStart || !weekEnd) return;
    try {
      const res = await apiFetch(
        `/workspaces/${id}/calendar?from=${weekStart.getTime()}&to=${weekEnd.getTime()}`,
      );
      if (res.ok) setEntries((await res.json()).entries as CalendarEntry[]);
      setError(null);
    } catch {
      setError("Could not load the calendar. Is the API running?");
    }
  }, [id, weekStart, weekEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = entries.filter(
    (e) =>
      (channelFilter === "all" || e.channel === channelFilter) && (showOpen || e.kind !== "slot"),
  );

  const counts = {
    scheduled: visible.filter((e) => e.status === "scheduled").length,
    published: visible.filter((e) => e.status === "published").length,
    failed: visible.filter((e) => e.status === "failed").length,
    open: visible.filter((e) => e.status === "open").length,
  };

  const days = weekStart
    ? Array.from({ length: 7 }, (_, i) => {
        const dayStart = weekStart.getTime() + i * DAY_MS;
        return {
          label: DAY_LABELS[i],
          date: new Date(dayStart),
          entries: visible
            .filter((e) => e.at >= dayStart && e.at < dayStart + DAY_MS)
            .sort((a, b) => a.at - b.at),
        };
      })
    : [];

  const weekLabel =
    weekStart && weekEnd
      ? `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : "";

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={
          <>
            Everything going out across the workspace — scheduled and published posts plus open{" "}
            <Link href={`/workspaces/${id}/cadence`}>cadence</Link> slots.
          </>
        }
      />

      {error && <p className="error">{error}</p>}

      <Card>
        <div className="resolve-controls">
          <span className="page-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!weekStart}
              onClick={() => weekStart && setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}
            >
              ← Prev
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setWeekStart(startOfWeek(new Date()))}
            >
              This week
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!weekStart}
              onClick={() => weekStart && setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}
            >
              Next →
            </Button>
          </span>
          <strong className={styles.weekLabel}>{weekLabel}</strong>
          <label>
            Channel
            <Select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as Channel | "all")}
            >
              <option value="all">All channels</option>
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </Select>
          </label>
          <label className="cadence-day">
            <input type="checkbox" checked={showOpen} onChange={(e) => setShowOpen(e.target.checked)} />
            Show open slots
          </label>
          <span className={styles.counts}>
            <span className={styles.count}>
              <Icon name="calendar" size="sm" /> {counts.scheduled} scheduled
            </span>
            <span className={styles.count}>
              <Icon name="status-approved" size="sm" /> {counts.published} published
            </span>
            {counts.failed > 0 && (
              <span className={styles.count}>
                <Icon name="warning" size="sm" /> {counts.failed} failed
              </span>
            )}
            {showOpen && (
              <span className={styles.count}>
                <Icon name="add" size="sm" /> {counts.open} open
              </span>
            )}
          </span>
        </div>

        {weekStart && visible.length === 0 && !error ? (
          <EmptyState
            icon={<Icon name="calendar" size="lg" />}
            title="Nothing on the calendar this week"
            description={
              <>
                Scheduled and published posts land here automatically. Set a{" "}
                <Link href={`/workspaces/${id}/cadence`}>posting cadence</Link> to open weekly
                slots worth filling.
              </>
            }
          />
        ) : (
          <div className="calendar-grid">
            {days.map((d) => (
              <div key={d.label} className="calendar-day">
                <div className="calendar-day-head">
                  <strong>{d.label}</strong> {d.date.getDate()}
                </div>
                {d.entries.length === 0 ? (
                  <p className="empty calendar-empty">—</p>
                ) : (
                  d.entries.map((e, i) => (
                    <div
                      key={`${e.publicationId ?? e.cadenceId}-${e.at}-${i}`}
                      className={styles.entry}
                      data-kind={e.kind}
                      data-status={e.status}
                    >
                      <div className={styles.entryHead}>
                        <Icon name={entryIcon(e)} size="sm" />
                        <time>
                          {new Date(e.at).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        <span className={styles.entryBadge}>
                          <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                        </span>
                      </div>
                      <div className={styles.entryTitle}>
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noreferrer">
                            {e.title}
                          </a>
                        ) : (
                          e.title
                        )}
                      </div>
                      {(e.providerKey || e.channel || e.cadenceName) && (
                        <div className={styles.entryMeta}>
                          {[e.providerKey ?? e.channel, e.cadenceName].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
