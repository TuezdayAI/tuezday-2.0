"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CHANNELS, type CalendarEntry, type Channel } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day)); // back to Monday
  return date;
}

export default function CalendarPage() {
  const { id } = useParams<{ id: string }>();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [channelFilter, setChannelFilter] = useState<Channel | "all">("all");
  const [showOpen, setShowOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * DAY_MS), [weekStart]);

  const load = useCallback(async () => {
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

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayStart = weekStart.getTime() + i * DAY_MS;
    return {
      label: DAY_LABELS[i],
      date: new Date(dayStart),
      entries: visible
        .filter((e) => e.at >= dayStart && e.at < dayStart + DAY_MS)
        .sort((a, b) => a.at - b.at),
    };
  });

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calendar</h1>
          <p className="subtitle">
            Everything going out across the workspace — scheduled and published posts plus open{" "}
            <Link href={`/workspaces/${id}/cadence`}>cadence</Link> slots.
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <section className="panel">
        <div className="resolve-controls">
          <span className="page-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}
            >
              ← Prev
            </button>
            <button type="button" className="button-secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              This week
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}
            >
              Next →
            </button>
          </span>
          <strong>{weekLabel}</strong>
          <label>
            Channel
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as Channel | "all")}
            >
              <option value="all">All channels</option>
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </label>
          <label className="cadence-day">
            <input type="checkbox" checked={showOpen} onChange={(e) => setShowOpen(e.target.checked)} />
            Show open slots
          </label>
        </div>

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
                  <div key={`${e.publicationId ?? e.cadenceId}-${e.at}-${i}`} className="calendar-entry">
                    <span className={`cal-chip cal-${e.status}`}>{e.status}</span>
                    <div className="calendar-entry-time">
                      {new Date(e.at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {e.providerKey ? ` · ${e.providerKey}` : e.channel ? ` · ${e.channel}` : ""}
                    </div>
                    <div className="calendar-entry-title">
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.title}
                        </a>
                      ) : (
                        e.title
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
