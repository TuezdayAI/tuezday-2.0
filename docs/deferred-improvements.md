# Deferred improvements

> Standing log of deliberate "good enough for now" shortcuts taken during sprint work, so they can be
> revisited at scale rather than silently forgotten. Each entry: what we did, why it's fine for now,
> and what the better version looks like. Add to this list whenever a slice makes a conscious trade-off.

## Sprint 27 — Recurring cadence, calendar + mailer

1. **Cadence fill is synchronous on a worker tick.** Each fill creates scheduled `publication` rows
   inline (one round trip per draft), bounded to a 14-day horizon and run every few minutes by the
   worker. Fine for modest volumes. The better version runs fill on a dedicated scheduler with
   sub-minute precision and back-pressure for large fan-out.
2. **DST-gap wall-clock times resolve to the adjacent valid instant.** The slot math handles normal DST
   transitions, but the ~1 hour per year that *doesn't exist* locally (spring-forward gap) is mapped to
   the nearest valid instant rather than skipped or flagged. Acceptable for a posting scheduler; a
   library-backed implementation could surface the ambiguity.
3. **Cadence doesn't pre-validate posts at fill time.** It derives a title from the draft's first line
   (covers Reddit's title requirement) but doesn't run `validateSocialPost` before scheduling — an
   invalid post fails its receipt at fire time with the platform error (the existing failed-receipt +
   retry path). A pre-flight check could warn before the slot fires.
4. **Mailer is fire-and-log behind the interface.** `Mailer` (Resend impl + Console default) has no
   delivery-tracking table, retries, bounce/open webhooks, or templating engine. Invite emails are
   best-effort (a failure never blocks invite creation). The richer version (tracking + templates)
   arrives with the email-approvals (S39) and billing (S37) sprints that also depend on this seam.
