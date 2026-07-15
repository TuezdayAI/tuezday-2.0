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
import type { CalendarEntry, Campaign, Channel, Draft } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { reviewHref } from "@/lib/review-workspace";
import {
  calendarDensity,
  calendarEntryKey,
  calendarRecoveryLabel,
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
  if (e.kind === "external_action") {
    if (e.status === "blocked" || e.status === "stale") return "warning";
    if (e.status === "authorization_required") return "status-review";
    return "status-approved";
  }
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

function DetailPanel({
  entry,
  workspaceId,
  busy,
  onClose,
  onRetry,
  onCancel,
}: {
  entry: CalendarEntry;
  workspaceId: string;
  busy: boolean;
  onClose: () => void;
  onRetry: (publicationId: string) => void;
  onCancel: (publicationId: string) => void;
}) {
  const status = entryWorkflowStatus(entry);
  const recoveryLabel = calendarRecoveryLabel(entry);
  const publicationId = entry.publicationId;
  return (
    <aside className={styles.panel} aria-label="Calendar entry detail">
      <Card>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>{entry.title}</h3>
          <IconButton label="Close details" onClick={onClose}>
            <Icon name="close" size="sm" />
          </IconButton>
        </div>
        <div>
          {status ? (
            <WorkflowStatusBadge status={status} />
          ) : (
            <span className={styles.slotChip}>Open slot</span>
          )}
        </div>
        <dl className={styles.panelMeta}>
          <dt>When</dt>
          <dd>
            {new Date(entry.at).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </dd>
          {entry.campaignName && (
            <>
              <dt>Campaign</dt>
              <dd>{entry.campaignName}</dd>
            </>
          )}
          {(entry.providerKey ?? entry.channel) && (
            <>
              <dt>Destination</dt>
              <dd>{entry.providerKey ?? entry.channel}</dd>
            </>
          )}
          {entry.cadenceName && (
            <>
              <dt>Cadence</dt>
              <dd>{entry.cadenceName}</dd>
            </>
          )}
        </dl>
        {entry.error && <p className={styles.panelError}>{entry.error}</p>}
        <div className={styles.panelActions}>
          {entry.status === "failed" && publicationId && (
            <Button size="compact" disabled={busy} onClick={() => onRetry(publicationId)}>
              Retry now
            </Button>
          )}
          {entry.status === "scheduled" && publicationId && (
            <Button variant="danger" size="compact" disabled={busy} onClick={() => onCancel(publicationId)}>
              Cancel
            </Button>
          )}
          {entry.url && (
            <a href={entry.url} target="_blank" rel="noreferrer">
              View post <Icon name="external" size="sm" />
            </a>
          )}
          {entry.draftId && (
            <Link
              href={reviewHref(workspaceId, {
                tab: "approvals",
                campaign: entry.campaignId ?? undefined,
              })}
            >
              Open Review
            </Link>
          )}
          {entry.externalActionId && recoveryLabel && (
            <Link
              href={reviewHref(workspaceId, {
                tab: "authorizations",
                action: entry.externalActionId,
              })}
            >
              {recoveryLabel}
            </Link>
          )}
          {entry.campaignId && entry.kind !== "slot" && (
            <Link href={`/workspaces/${workspaceId}/campaigns/${entry.campaignId}?tab=results`}>
              View campaign results
            </Link>
          )}
          {entry.kind === "slot" && (
            <Link href={`/workspaces/${workspaceId}/cadence`}>Manage cadence</Link>
          )}
        </div>
        {entry.kind === "slot" && (
          <p className={styles.entryMeta}>
            This slot fills automatically from the next approved draft matching its campaign and
            channel.
          </p>
        )}
      </Card>
    </aside>
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
  const [pendingDrafts, setPendingDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
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
      const [cRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/campaigns`).catch(() => null),
        apiFetch(`/workspaces/${id}/drafts?state=pending_review`).catch(() => null),
      ]);
      if (cRes?.ok) setCampaigns((await cRes.json()) as Campaign[]);
      if (dRes?.ok) setPendingDrafts((await dRes.json()) as Draft[]);
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
    setSelectedKey((key) =>
      key === calendarEntryKey(entry) ? null : calendarEntryKey(entry),
    );
  };

  // Resolve the selection against the visible set so it clears itself when
  // filters, the window, or a reload drop the entry.
  const selected = visible.find((entry) => calendarEntryKey(entry) === selectedKey) ?? null;

  const pendingScoped = pendingDrafts.filter(
    (d) =>
      (campaignFilter === "all" || d.campaignId === campaignFilter) &&
      (channelFilter === "all" || d.channel === channelFilter),
  );

  async function retryPublication(publicationId: string) {
    setBusy(true);
    try {
      await apiFetch(`/workspaces/${id}/publications/${publicationId}/retry`, { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancelPublication(publicationId: string) {
    if (!confirm("Cancel this scheduled post?")) return;
    setBusy(true);
    try {
      await apiFetch(`/workspaces/${id}/publications/${publicationId}`, { method: "DELETE" });
      setSelectedKey(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

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

      {pendingScoped.length > 0 && (
        <div className={styles.reviewRail}>
          <Icon name="review" size="sm" />
          <span>
            {pendingScoped.length} generated draft{pendingScoped.length === 1 ? "" : "s"} awaiting
            review{hasScopeFilter ? " in this scope" : ""} — approve them to fill open slots.
          </span>
          <Link
            href={reviewHref(id, {
              tab: "approvals",
              campaign: campaignFilter !== "all" ? campaignFilter : undefined,
            })}
          >
            Open Review
          </Link>
        </div>
      )}

      <div className={styles.layout} data-panel={selected ? "" : undefined}>
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
              size="compact"
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
            variant="tertiary"
            size="compact"
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
            <Button variant="tertiary" size="compact" onClick={clearScopeFilters}>
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
                          key={calendarEntryKey(e)}
                          entry={e}
                          selected={selectedKey === calendarEntryKey(e)}
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
                        key={calendarEntryKey(e)}
                        entry={e}
                        selected={selectedKey === calendarEntryKey(e)}
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

      {selected && (
        <DetailPanel
          entry={selected}
          workspaceId={id}
          busy={busy}
          onClose={() => setSelectedKey(null)}
          onRetry={(publicationId) => void retryPublication(publicationId)}
          onCancel={(publicationId) => void cancelPublication(publicationId)}
        />
      )}
      </div>
    </>
  );
}
