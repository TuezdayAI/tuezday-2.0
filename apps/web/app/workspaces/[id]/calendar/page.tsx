"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button, IconButton } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { Tabs } from "@/src/components/ui/tabs";
import styles from "./calendar.module.css";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CalendarEntry, Campaign, Channel } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  calendarDensity,
  calendarView,
  entryChannels,
  entryWorkflowStatus,
  filterCalendarEntries,
  monthGrid,
  rangeFor,
  shiftAnchor,
  startOfWeek,
  weekDays,
  type CalendarViewMode,
} from "@/lib/calendar-workspace";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function entryIcon(e: CalendarEntry): IconName {
  if (e.kind === "slot") return "calendar";
  if (e.channel === "email") return "email";
  if (e.channel === "ads") return "ad";
  if (e.channel === "web") return "blog";
  return "post";
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function EntryCard({
  entry,
  selected,
  onSelect,
}: {
  entry: CalendarEntry;
  selected: boolean;
  onSelect: (entry: CalendarEntry) => void;
}) {
  const status = entryWorkflowStatus(entry);
  return (
    <button
      type="button"
      className={styles.entry}
      data-kind={entry.kind}
      data-status={entry.status}
      data-selected={selected || undefined}
      onClick={() => onSelect(entry)}
    >
      <div className={styles.entryHead}>
        <Icon name={entryIcon(entry)} size="sm" />
        <time>
          {new Date(entry.at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        {status ? (
          <span className={styles.entryBadge}>
            <WorkflowStatusBadge status={status} />
          </span>
        ) : (
          <span className={styles.slotChip}>Open slot</span>
        )}
      </div>
      <div className={styles.entryTitle}>{entry.title}</div>
      {(entry.campaignName || entry.providerKey || entry.channel || entry.cadenceName) && (
        <div className={styles.entryMeta}>
          {[entry.campaignName, entry.providerKey ?? entry.channel, entry.cadenceName]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </button>
  );
}

export default function CalendarPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const view = calendarView(searchParams.get("view"));
  const density = calendarDensity(searchParams.get("density"));
  const campaignFilter = searchParams.get("campaign") ?? "all";
  const channelFilter = (searchParams.get("channel") as Channel | null) ?? "all";

  // Initialized on the client only — the server can't know the viewer's week,
  // and rendering dates during SSR caused hydration mismatches.
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAnchor((a) => a ?? new Date());
  }, []);

  const load = useCallback(async () => {
    if (!anchor) return;
    const { from, to } = rangeFor(view, anchor);
    try {
      const res = await apiFetch(`/workspaces/${id}/calendar?from=${from}&to=${to}`);
      if (res.ok) setEntries((await res.json()).entries as CalendarEntry[]);
      setError(null);
    } catch {
      setError("Could not load the calendar. Is the API running?");
    }
  }, [id, view, anchor]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(`/workspaces/${id}/campaigns`).catch(() => null);
      if (res?.ok) setCampaigns((await res.json()) as Campaign[]);
    })();
  }, [id]);

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `?${query}` : pathname, { scroll: false });
  }

  function clearScopeFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("campaign");
    params.delete("channel");
    const query = params.toString();
    router.replace(query ? `?${query}` : pathname, { scroll: false });
  }

  const visible = filterCalendarEntries(entries, {
    campaignId: campaignFilter,
    channel: channelFilter,
  });
  const hasScopeFilter = campaignFilter !== "all" || channelFilter !== "all";
  const channels = entryChannels(entries);

  const counts = {
    scheduled: visible.filter((e) => e.status === "scheduled").length,
    published: visible.filter((e) => e.status === "published").length,
    failed: visible.filter((e) => e.status === "failed").length,
    open: visible.filter((e) => e.status === "open").length,
  };

  const today = new Date();
  const entryKey = (e: CalendarEntry) => `${e.publicationId ?? e.cadenceId}-${e.at}`;
  const entriesOn = (day: Date) =>
    visible.filter((e) => isSameDay(new Date(e.at), day)).sort((a, b) => a.at - b.at);

  const rangeLabel = !anchor
    ? ""
    : view === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : (() => {
          const start = startOfWeek(anchor);
          const end = new Date(start);
          end.setDate(end.getDate() + 6);
          const fmt = (d: Date) =>
            d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return `${fmt(start)} – ${fmt(end)}`;
        })();

  const selectEntry = (entry: CalendarEntry) => {
    setSelectedKey((k) => (k === entryKey(entry) ? null : entryKey(entry)));
  };

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={
          <>
            Everything going out across the workspace — planned slots, scheduled and published
            posts, and anything that needs recovery. Open{" "}
            <Link href={`/workspaces/${id}/cadence`}>cadence</Link> slots fill from approved
            drafts.
          </>
        }
      />

      {error && <p className="error">{error}</p>}

      <Card>
        <div className={styles.toolbar}>
          <span className={styles.rangeNav}>
            <IconButton
              label="Previous"
              disabled={!anchor}
              onClick={() => anchor && setAnchor(shiftAnchor(view, anchor, -1))}
            >
              <Icon name="chevron-left" size="sm" />
            </IconButton>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAnchor(new Date())}
            >
              Today
            </Button>
            <IconButton
              label="Next"
              disabled={!anchor}
              onClick={() => anchor && setAnchor(shiftAnchor(view, anchor, 1))}
            >
              <Icon name="chevron-right" size="sm" />
            </IconButton>
          </span>
          <strong className={styles.rangeLabel}>{rangeLabel}</strong>

          <Tabs
            tabs={[
              { key: "week", label: "Week" },
              { key: "month", label: "Month" },
            ]}
            active={view}
            onChange={(key) => setParam("view", key === "week" ? null : (key as CalendarViewMode))}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setParam("density", density === "comfortable" ? "compact" : null)}
          >
            {density === "comfortable" ? "Compact" : "Comfortable"}
          </Button>

          <label className={styles.filterField}>
            <span>Campaign</span>
            <select
              value={campaignFilter}
              onChange={(e) =>
                setParam("campaign", e.target.value === "all" ? null : e.target.value)
              }
            >
              <option value="all">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filterField}>
            <span>Channel</span>
            <select
              value={channelFilter}
              onChange={(e) =>
                setParam("channel", e.target.value === "all" ? null : e.target.value)
              }
            >
              <option value="all">All channels</option>
              {channels.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>
          </label>
          {hasScopeFilter && (
            <Button variant="ghost" size="sm" onClick={clearScopeFilters}>
              Clear filters
            </Button>
          )}

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
            <span className={styles.count}>
              <Icon name="add" size="sm" /> {counts.open} open
            </span>
          </span>
        </div>

        {anchor && visible.length === 0 && !error ? (
          hasScopeFilter ? (
            <EmptyState
              icon={<Icon name="calendar" size="lg" />}
              title="Nothing matches these filters"
              description="No planned, scheduled, or published work matches the current campaign and channel scope in this period."
              primaryAction={
                <Button variant="secondary" onClick={clearScopeFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Icon name="calendar" size="lg" />}
              title={`Nothing on the calendar this ${view}`}
              description={
                <>
                  Scheduled and published posts land here automatically. Set a{" "}
                  <Link href={`/workspaces/${id}/cadence`}>posting cadence</Link> to open weekly
                  slots worth filling.
                </>
              }
            />
          )
        ) : (
          <div data-density={density}>
            {view === "week" && anchor && (
              <div className="calendar-grid">
                {weekDays(anchor).map((day, i) => (
                  <div
                    key={day.toISOString()}
                    className={`calendar-day ${styles.weekDay}`}
                    data-today={isSameDay(day, today) || undefined}
                  >
                    <div className="calendar-day-head">
                      <strong>{DAY_LABELS[i]}</strong> {day.getDate()}
                    </div>
                    {entriesOn(day).length === 0 ? (
                      <p className="empty calendar-empty">—</p>
                    ) : (
                      entriesOn(day).map((e) => (
                        <EntryCard
                          key={entryKey(e)}
                          entry={e}
                          selected={selectedKey === entryKey(e)}
                          onSelect={selectEntry}
                        />
                      ))
                    )}
                  </div>
                ))}
              </div>
            )}

            {view === "month" && anchor && (
              <div className={styles.monthGrid}>
                {DAY_LABELS.map((label) => (
                  <div key={label} className={styles.monthHead}>
                    {label}
                  </div>
                ))}
                {monthGrid(anchor).map((day) => (
                  <div
                    key={day.toISOString()}
                    className={styles.monthCell}
                    data-out-month={day.getMonth() !== anchor.getMonth() || undefined}
                    data-today={isSameDay(day, today) || undefined}
                  >
                    <div className={styles.monthCellHead}>{day.getDate()}</div>
                    {entriesOn(day).map((e) => (
                      <EntryCard
                        key={entryKey(e)}
                        entry={e}
                        selected={selectedKey === entryKey(e)}
                        onSelect={selectEntry}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
