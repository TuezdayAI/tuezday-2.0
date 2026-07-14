import { describe, expect, it } from "vitest";
import type { CalendarEntry } from "@tuezday/contracts";
import {
  calendarDensity,
  calendarHref,
  calendarView,
  entryCampaigns,
  entryChannels,
  entryWorkflowStatus,
  filterCalendarEntries,
  monthGrid,
  rangeFor,
  shiftAnchor,
  startOfWeek,
  weekDays,
} from "./calendar-workspace";

function entry(over: Partial<CalendarEntry>): CalendarEntry {
  return {
    kind: "publication",
    at: 0,
    cadenceId: null,
    cadenceName: null,
    campaignId: null,
    campaignName: null,
    channel: "linkedin",
    providerKey: "linkedin",
    status: "scheduled",
    title: "Post",
    draftId: null,
    publicationId: null,
    url: null,
    error: null,
    ...over,
  };
}

describe("calendar workspace view model", () => {
  it("parses view and density params with defaults", () => {
    expect(calendarView(null)).toBe("week");
    expect(calendarView("month")).toBe("month");
    expect(calendarView("bogus")).toBe("week");
    expect(calendarDensity(null)).toBe("comfortable");
    expect(calendarDensity("compact")).toBe("compact");
    expect(calendarDensity("bogus")).toBe("comfortable");
  });

  it("builds hrefs omitting default values", () => {
    expect(calendarHref("ws1")).toBe("/workspaces/ws1/calendar");
    expect(calendarHref("ws1", { view: "week", density: "comfortable" })).toBe(
      "/workspaces/ws1/calendar",
    );
    expect(
      calendarHref("ws1", { view: "month", density: "compact", campaign: "c1", channel: "x" }),
    ).toBe("/workspaces/ws1/calendar?view=month&density=compact&campaign=c1&channel=x");
  });

  it("computes Monday-start weeks", () => {
    // 2026-07-13 is a Monday; 2026-07-19 is the Sunday of the same week.
    expect(startOfWeek(new Date(2026, 6, 15)).getDay()).toBe(1);
    expect(startOfWeek(new Date(2026, 6, 19, 23, 59)).getDate()).toBe(13);
    const days = weekDays(new Date(2026, 6, 15));
    expect(days).toHaveLength(7);
    expect(days[0]?.getDate()).toBe(13);
    expect(days[6]?.getDate()).toBe(19);
  });

  it("builds a 42-cell month grid starting the Monday on or before the 1st", () => {
    // July 2026 starts on a Wednesday → grid starts Monday June 29.
    const cells = monthGrid(new Date(2026, 6, 13));
    expect(cells).toHaveLength(42);
    expect(cells[0]?.getDay()).toBe(1);
    expect(cells[0]?.getMonth()).toBe(5);
    expect(cells[0]?.getDate()).toBe(29);
    expect(cells[41]?.getMonth()).toBe(7); // Aug 9
  });

  it("derives fetch windows and pages the anchor per view", () => {
    const anchor = new Date(2026, 6, 15);
    const week = rangeFor("week", anchor);
    expect(new Date(week.from).getDate()).toBe(13);
    expect(new Date(week.to).getDate()).toBe(20);
    const month = rangeFor("month", anchor);
    expect(new Date(month.from).getDate()).toBe(29);
    expect(month.to).toBeGreaterThan(month.from);

    expect(shiftAnchor("week", anchor, 1).getDate()).toBe(22);
    expect(shiftAnchor("week", anchor, -1).getDate()).toBe(8);
    expect(shiftAnchor("month", anchor, 1).getMonth()).toBe(7);
    expect(shiftAnchor("month", anchor, -1).getMonth()).toBe(5);
  });

  it("maps publication statuses to the canonical vocabulary and leaves slots unbadged", () => {
    expect(entryWorkflowStatus(entry({ status: "scheduled" }))).toBe("scheduled");
    expect(entryWorkflowStatus(entry({ status: "published" }))).toBe("completed");
    expect(entryWorkflowStatus(entry({ status: "failed" }))).toBe("failed");
    expect(entryWorkflowStatus(entry({ kind: "slot", status: "open" }))).toBeNull();
  });

  it("maps external action calendar states to the canonical vocabulary", () => {
    expect(
      entryWorkflowStatus(entry({ kind: "external_action", status: "authorization_required" })),
    ).toBe("authorization_required");
    expect(entryWorkflowStatus(entry({ kind: "external_action", status: "authorized" }))).toBe(
      "authorized",
    );
    expect(entryWorkflowStatus(entry({ kind: "external_action", status: "blocked" }))).toBe(
      "policy_blocked",
    );
    expect(entryWorkflowStatus(entry({ kind: "external_action", status: "stale" }))).toBe(
      "stale",
    );
  });

  it("filters by campaign and channel", () => {
    const entries = [
      entry({ campaignId: "c1", channel: "linkedin", title: "a" }),
      entry({ campaignId: "c2", channel: "x", title: "b" }),
      entry({ campaignId: null, channel: "email", title: "c" }),
    ];
    expect(filterCalendarEntries(entries, { campaignId: "all", channel: "all" })).toHaveLength(3);
    expect(
      filterCalendarEntries(entries, { campaignId: "c1", channel: "all" }).map((e) => e.title),
    ).toEqual(["a"]);
    expect(
      filterCalendarEntries(entries, { campaignId: "all", channel: "x" }).map((e) => e.title),
    ).toEqual(["b"]);
    expect(filterCalendarEntries(entries, { campaignId: "c1", channel: "x" })).toHaveLength(0);
  });

  it("lists distinct campaigns and channels in first-seen order", () => {
    const entries = [
      entry({ campaignId: "c1", campaignName: "Launch", channel: "linkedin" }),
      entry({ campaignId: "c1", campaignName: "Launch", channel: "x" }),
      entry({ campaignId: "c2", campaignName: null, channel: "linkedin" }),
      entry({ campaignId: null, channel: null }),
    ];
    expect(entryCampaigns(entries)).toEqual([
      { id: "c1", name: "Launch" },
      { id: "c2", name: "c2" },
    ]);
    expect(entryChannels(entries)).toEqual(["linkedin", "x"]);
  });
});
