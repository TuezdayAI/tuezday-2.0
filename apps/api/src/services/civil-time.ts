import { Temporal } from "@js-temporal/polyfill";

export interface WallClockInput {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}

export type WallClockResolution =
  | { ok: true; instantMs: number }
  | { ok: false; reason: "nonexistent_local_time" };

function matchesWallClock(
  value: Temporal.ZonedDateTime,
  input: WallClockInput,
): boolean {
  return (
    value.year === input.year &&
    value.month === input.month &&
    value.day === input.day &&
    value.hour === input.hour &&
    value.minute === input.minute
  );
}

/**
 * Resolve an IANA-zone wall clock to one exact instant.
 *
 * Temporal's `earlier` disambiguation intentionally selects the first instant
 * in a fall overlap. For a spring gap it adjusts to a different wall clock, so
 * the round-trip comparison makes that invalid slot explicit instead of
 * silently shifting the scheduled time.
 */
export function resolveWallClock(input: WallClockInput): WallClockResolution {
  const value = Temporal.ZonedDateTime.from(
    {
      timeZone: input.timeZone,
      year: input.year,
      month: input.month,
      day: input.day,
      hour: input.hour,
      minute: input.minute,
    },
    { disambiguation: "earlier", overflow: "reject" },
  );
  if (!matchesWallClock(value, input)) {
    return { ok: false, reason: "nonexistent_local_time" };
  }
  return { ok: true, instantMs: value.epochMilliseconds };
}

/** Exact start/end instants for the civil day containing `instantMs`. */
export function zonedDayBounds(
  instantMs: number,
  timeZone: string,
): { start: number; end: number } {
  const current = Temporal.Instant.fromEpochMilliseconds(instantMs).toZonedDateTimeISO(timeZone);
  const start = current.startOfDay();
  const end = start.add({ days: 1 }).startOfDay();
  return { start: start.epochMilliseconds, end: end.epochMilliseconds };
}
