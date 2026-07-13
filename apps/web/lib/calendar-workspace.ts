import type {
  CalendarEntry,
  CalendarEntryStatus,
  Channel,
  WorkflowStatus,
} from "@tuezday/contracts";

export const CALENDAR_VIEWS = ["week", "month"] as const;
export type CalendarViewMode = (typeof CALENDAR_VIEWS)[number];

export const CALENDAR_DENSITIES = ["comfortable", "compact"] as const;
export type CalendarDensity = (typeof CALENDAR_DENSITIES)[number];

export function calendarView(value: string | null): CalendarViewMode {
  return CALENDAR_VIEWS.includes(value as CalendarViewMode) ? (value as CalendarViewMode) : "week";
}

export function calendarDensity(value: string | null): CalendarDensity {
  return CALENDAR_DENSITIES.includes(value as CalendarDensity)
    ? (value as CalendarDensity)
    : "comfortable";
}

export function calendarHref(
  workspaceId: string,
  opts?: {
    view?: CalendarViewMode;
    density?: CalendarDensity;
    campaign?: string;
    channel?: string;
  },
): string {
  const params = new URLSearchParams();
  if (opts?.view && opts.view !== "week") params.set("view", opts.view);
  if (opts?.density && opts.density !== "comfortable") params.set("density", opts.density);
  if (opts?.campaign) params.set("campaign", opts.campaign);
  if (opts?.channel) params.set("channel", opts.channel);
  const query = params.toString();
  return `/workspaces/${workspaceId}/calendar${query ? `?${query}` : ""}`;
}

/** Midnight on the Monday of the given date's week (local time). */
export function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return date;
}

function addDays(d: Date, days: number): Date {
  const date = new Date(d);
  date.setDate(date.getDate() + days);
  return date;
}

/** The seven days of the anchor's week, Monday first. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * A fixed 6×7 grid for the anchor's month, starting the Monday on or before
 * the 1st. Cells outside the month are included so rows stay aligned.
 */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The fetch window (ms timestamps) covering everything the view renders. */
export function rangeFor(view: CalendarViewMode, anchor: Date): { from: number; to: number } {
  if (view === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    return { from: start.getTime(), to: addDays(start, 42).getTime() };
  }
  const start = startOfWeek(anchor);
  return { from: start.getTime(), to: addDays(start, 7).getTime() };
}

/** Step the anchor one page in the current view: ±7 days or ±1 month. */
export function shiftAnchor(view: CalendarViewMode, anchor: Date, delta: -1 | 1): Date {
  if (view === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
  return addDays(anchor, delta * 7);
}

// Open slots are planned-but-unfilled commitments, not work items — they get
// no workflow status; the page renders them as distinct slot chips.
const ENTRY_WORKFLOW_STATUS: Record<CalendarEntryStatus, WorkflowStatus | null> = {
  open: null,
  scheduled: "scheduled",
  published: "completed",
  failed: "failed",
};

export function entryWorkflowStatus(entry: CalendarEntry): WorkflowStatus | null {
  return ENTRY_WORKFLOW_STATUS[entry.status];
}

export interface CalendarFilters {
  campaignId: string | "all";
  channel: Channel | "all";
}

export function filterCalendarEntries(
  entries: CalendarEntry[],
  filters: CalendarFilters,
): CalendarEntry[] {
  return entries.filter(
    (e) =>
      (filters.campaignId === "all" || e.campaignId === filters.campaignId) &&
      (filters.channel === "all" || e.channel === filters.channel),
  );
}

/** Distinct campaigns present in the loaded entries, first-seen order. */
export function entryCampaigns(entries: CalendarEntry[]): Array<{ id: string; name: string }> {
  const seen: Array<{ id: string; name: string }> = [];
  for (const e of entries) {
    if (e.campaignId && !seen.some((c) => c.id === e.campaignId)) {
      seen.push({ id: e.campaignId, name: e.campaignName ?? e.campaignId });
    }
  }
  return seen;
}

/** Distinct channels present in the loaded entries, first-seen order. */
export function entryChannels(entries: CalendarEntry[]): Channel[] {
  const seen: Channel[] = [];
  for (const e of entries) if (e.channel && !seen.includes(e.channel)) seen.push(e.channel);
  return seen;
}
