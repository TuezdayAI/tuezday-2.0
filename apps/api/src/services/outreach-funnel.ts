import { and, eq, inArray } from "drizzle-orm";
import type {
  CampaignOutreachInsights,
  FunnelCounts,
  FunnelSlice,
  OutreachFunnel,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  emailDeliveries,
  inboxItems,
  outreachEnrollments,
  outreachMessages,
  outreachSequences,
  personas,
} from "../db/schema";

/** A per-send funnel row being tallied (before it collapses to counts). */
interface SendRow {
  stepNumber: number;
  recipientType: string;
  opened: boolean;
  clicked: boolean;
  replied: boolean;
  positive: boolean;
}

const EMPTY: FunnelCounts = {
  sent: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  positive: 0,
  meetings: 0,
  won: 0,
  lost: 0,
};

function tally(rows: SendRow[]): Omit<FunnelCounts, "meetings" | "won" | "lost"> {
  return {
    sent: rows.length,
    opened: rows.filter((r) => r.opened).length,
    clicked: rows.filter((r) => r.clicked).length,
    replied: rows.filter((r) => r.replied).length,
    positive: rows.filter((r) => r.positive).length,
  };
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

/**
 * The per-send funnel + attribution for a sequence (Sprint 50). "Sent" is one
 * per dispatched step-message; opened/clicked come from the tracking counters
 * on email_deliveries; replied/positive from the linked inbox items. Meetings/
 * won/lost are the manual per-enrollment outcomes (a separate terminal layer).
 */
export function getSequenceFunnel(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachFunnel | undefined {
  const sequence = db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)))
    .get();
  if (!sequence) return undefined;

  const persona = db.select({ name: personas.name }).from(personas).where(eq(personas.id, sequence.personaId)).get();

  // Enrollments of this sequence → their manual outcomes + recipient type.
  const enrollments = db
    .select({
      id: outreachEnrollments.id,
      recipientType: outreachEnrollments.recipientType,
      outcome: outreachEnrollments.outcome,
    })
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.sequenceId, sequenceId))
    .all();
  const enrollmentType = new Map(enrollments.map((e) => [e.id, e.recipientType]));

  // Sent step-messages of those enrollments = the funnel's "sent" denominator.
  const sentMessages = enrollments.length
    ? db
        .select({ id: outreachMessages.id, enrollmentId: outreachMessages.enrollmentId, stepNumber: outreachMessages.stepNumber })
        .from(outreachMessages)
        .where(
          and(
            inArray(outreachMessages.enrollmentId, enrollments.map((e) => e.id)),
            eq(outreachMessages.status, "sent"),
          ),
        )
        .all()
    : [];

  // Deliveries for those messages (origin=outreach_step, originId=message.id).
  const deliveries = sentMessages.length
    ? db
        .select({
          id: emailDeliveries.id,
          originId: emailDeliveries.originId,
          openCount: emailDeliveries.openCount,
          clickCount: emailDeliveries.clickCount,
        })
        .from(emailDeliveries)
        .where(
          and(
            eq(emailDeliveries.workspaceId, workspaceId),
            eq(emailDeliveries.origin, "outreach_step"),
            inArray(emailDeliveries.originId, sentMessages.map((m) => m.id)),
          ),
        )
        .all()
    : [];
  const deliveryByMessageId = new Map(deliveries.map((d) => [d.originId, d]));

  // Email replies on those deliveries.
  const replies = deliveries.length
    ? db
        .select({ deliveryId: inboxItems.emailDeliveryId, label: inboxItems.replyLabel })
        .from(inboxItems)
        .where(
          and(
            eq(inboxItems.workspaceId, workspaceId),
            eq(inboxItems.kind, "email"),
            inArray(inboxItems.emailDeliveryId, deliveries.map((d) => d.id)),
          ),
        )
        .all()
    : [];
  const repliedDeliveryIds = new Set<string>();
  const positiveDeliveryIds = new Set<string>();
  for (const r of replies) {
    if (!r.deliveryId) continue;
    repliedDeliveryIds.add(r.deliveryId);
    if (r.label === "positive") positiveDeliveryIds.add(r.deliveryId);
  }

  const rows: SendRow[] = sentMessages.map((m) => {
    const delivery = deliveryByMessageId.get(m.id);
    return {
      stepNumber: m.stepNumber,
      recipientType: enrollmentType.get(m.enrollmentId) ?? "lead",
      opened: !!delivery && delivery.openCount > 0,
      clicked: !!delivery && delivery.clickCount > 0,
      replied: !!delivery && repliedDeliveryIds.has(delivery.id),
      positive: !!delivery && positiveDeliveryIds.has(delivery.id),
    };
  });

  const outcomes = {
    meetings: enrollments.filter((e) => e.outcome === "meeting").length,
    won: enrollments.filter((e) => e.outcome === "won").length,
    lost: enrollments.filter((e) => e.outcome === "lost").length,
  };
  const totals: FunnelCounts = { ...tally(rows), ...outcomes };

  const slice = (key: string, label: string, subset: SendRow[], counts?: Partial<FunnelCounts>): FunnelSlice => ({
    key,
    label,
    ...EMPTY,
    ...tally(subset),
    ...counts,
  });

  // byStep — the meaningful per-sequence breakdown.
  const steps = [...new Set(rows.map((r) => r.stepNumber))].sort((a, b) => a - b);
  const byStep = steps.map((n) => slice(String(n), `Step ${n}`, rows.filter((r) => r.stepNumber === n)));

  // byPersona — one row (a sequence has a single persona).
  const byPersona = [slice(sequence.personaId, persona?.name ?? "Persona", rows, outcomes)];

  // bySegment — split by recipient type (lead vs contact).
  const bySegment = ["lead", "contact"]
    .map((t) => ({ t, subset: rows.filter((r) => r.recipientType === t) }))
    .filter(({ subset }) => subset.length > 0)
    .map(({ t, subset }) => slice(t, t === "lead" ? "Leads" : "Contacts", subset));

  return {
    sequenceId,
    ...totals,
    openRate: rate(totals.opened, totals.sent),
    clickRate: rate(totals.clicked, totals.sent),
    replyRate: rate(totals.replied, totals.sent),
    positiveRate: rate(totals.positive, totals.sent),
    attribution: { byStep, byPersona, bySegment },
  };
}

/** Aggregate outreach funnel across a campaign's sequences, for insights (S34). */
export function getCampaignOutreachFunnel(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignOutreachInsights {
  const sequences = db
    .select({ id: outreachSequences.id })
    .from(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.campaignId, campaignId)))
    .all();

  const agg: FunnelCounts = { ...EMPTY };
  for (const s of sequences) {
    const f = getSequenceFunnel(db, workspaceId, s.id);
    if (!f) continue;
    agg.sent += f.sent;
    agg.opened += f.opened;
    agg.clicked += f.clicked;
    agg.replied += f.replied;
    agg.positive += f.positive;
    agg.meetings += f.meetings;
    agg.won += f.won;
    agg.lost += f.lost;
  }
  return {
    ...agg,
    sequenceCount: sequences.length,
    replyRate: rate(agg.replied, agg.sent),
    positiveRate: rate(agg.positive, agg.sent),
  };
}
