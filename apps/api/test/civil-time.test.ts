import { describe, expect, it } from "vitest";
import { resolveWallClock, zonedDayBounds } from "../src/services/civil-time";

describe("civil time", () => {
  it("finds Kolkata's local midnight across the UTC date boundary", () => {
    const instant = Date.parse("2026-08-07T10:00:00.000Z");
    expect(zonedDayBounds(instant, "Asia/Kolkata")).toEqual({
      start: Date.parse("2026-08-06T18:30:00.000Z"),
      end: Date.parse("2026-08-07T18:30:00.000Z"),
    });
  });

  it("uses the actual 23-hour New York spring-forward day", () => {
    const bounds = zonedDayBounds(
      Date.parse("2026-03-08T12:00:00.000Z"),
      "America/New_York",
    );
    expect(bounds).toEqual({
      start: Date.parse("2026-03-08T05:00:00.000Z"),
      end: Date.parse("2026-03-09T04:00:00.000Z"),
    });
    expect(bounds.end - bounds.start).toBe(23 * 60 * 60 * 1_000);
  });

  it("uses the actual 25-hour New York fall-back day", () => {
    const bounds = zonedDayBounds(
      Date.parse("2026-11-01T12:00:00.000Z"),
      "America/New_York",
    );
    expect(bounds).toEqual({
      start: Date.parse("2026-11-01T04:00:00.000Z"),
      end: Date.parse("2026-11-02T05:00:00.000Z"),
    });
    expect(bounds.end - bounds.start).toBe(25 * 60 * 60 * 1_000);
  });

  it("rejects a nonexistent spring-forward wall clock", () => {
    expect(
      resolveWallClock({
        year: 2026,
        month: 3,
        day: 8,
        hour: 2,
        minute: 30,
        timeZone: "America/New_York",
      }),
    ).toEqual({ ok: false, reason: "nonexistent_local_time" });
  });

  it("chooses exactly the earlier instant for a fall-back overlap", () => {
    expect(
      resolveWallClock({
        year: 2026,
        month: 11,
        day: 1,
        hour: 1,
        minute: 30,
        timeZone: "America/New_York",
      }),
    ).toEqual({ ok: true, instantMs: Date.parse("2026-11-01T05:30:00.000Z") });
  });

  it("resolves ordinary wall clocks without host-timezone dependence", () => {
    expect(
      resolveWallClock({
        year: 2026,
        month: 8,
        day: 7,
        hour: 9,
        minute: 15,
        timeZone: "Asia/Kolkata",
      }),
    ).toEqual({ ok: true, instantMs: Date.parse("2026-08-07T03:45:00.000Z") });
  });
});
