// Sprint 70 (PRD §8, Move 7a): the agent inbox — one ranked feed, three lanes.
//
// This file closes atlas conflict #7. Before it, `priorities` ranked nine kinds
// of operational work and `next-action` ranked an overlapping set of counts plus
// a setup checklist; both answered "what should you look at", both read the same
// tables, and the founder saw them in two places that could disagree.
//
// Now there is one comparator (`inboxTier` + `rankInboxItems`) and everything
// else is a projection of it: `/priorities` is this feed minus the ask and setup
// lanes, and `next-action` no longer ranks work at all (D-70.9).

import {
  agentInboxLaneFor,
  checklistProgress,
  type AgentInboxFeed,
  type AgentInboxItem,
  type AgentInboxItemKind,
  type AgentQuestion,
  type PriorityItem,
  type PriorityQueue,
  type SetupChecklistItem,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { listAgentQuestions } from "./agent-questions";
import { getNextActionState } from "./next-action";
import { collectPriorityItems } from "./priorities";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Ranking tiers, most urgent first.
 *
 * 0 — something already broke and its deadline has passed.
 * 1 — an agent is stopped and only the founder can start it (D-70.10). It ranks
 *     below a live failure because nothing is on fire, and above everything else
 *     because work is halted and the fix is usually one sentence.
 * 2 — an overdue authorization.
 * 3 — a failure that is not yet overdue.
 * 4 — an authorization waiting.
 * 5 — risks and reviews that stop the machine getting better, not stop it working.
 * 6 — ordinary content review.
 * 7 — untargeted triage and setup steps.
 */
function inboxTier(item: AgentInboxItem, now: number): number {
  const overdue = item.dueAt !== null && item.dueAt <= now;
  const failureLike =
    item.kind === "execution_failure" ||
    item.kind === "policy_block" ||
    item.kind === "stale_action";
  if (failureLike && overdue) return 0;
  if (item.kind === "agent_question") return 1;
  if (item.kind === "authorization" && overdue) return 2;
  if (failureLike) return 3;
  if (item.kind === "authorization") return 4;
  if (
    item.kind === "connection_health" ||
    item.kind === "campaign_risk" ||
    item.kind === "learning_review" ||
    (item.kind === "signal_triage" && item.campaignId !== null)
  ) {
    return 5;
  }
  if (item.kind === "content_review") return 6;
  return 7;
}

/** The one comparator. Deterministic to the id, so the order never flickers. */
export function rankInboxItems(items: AgentInboxItem[], now: number): AgentInboxItem[] {
  return [...items].sort((left, right) => {
    const byTier = inboxTier(left, now) - inboxTier(right, now);
    if (byTier !== 0) return byTier;
    const byDue = (left.dueAt ?? left.createdAt) - (right.dueAt ?? right.createdAt);
    if (byDue !== 0) return byDue;
    const byCreated = left.createdAt - right.createdAt;
    if (byCreated !== 0) return byCreated;
    return left.id.localeCompare(right.id);
  });
}

function laned(item: PriorityItem): AgentInboxItem {
  return {
    ...item,
    kind: item.kind as AgentInboxItemKind,
    lane: agentInboxLaneFor(item.kind as AgentInboxItemKind),
    question: null,
  };
}

/** How each question type reads to the founder, and what is at stake. */
const QUESTION_CONSEQUENCE: Record<AgentQuestion["type"], string> = {
  disambiguation: "The run is paused until you say which reading is right.",
  missing_permission: "The run is paused rather than assume it has permission.",
  missing_fact: "The run is paused because this is not recorded anywhere it can look.",
  policy_escalation: "The run is paused because continuing would go beyond how it is configured.",
};

export function questionItem(workspaceId: string, question: AgentQuestion): AgentInboxItem {
  return {
    id: question.id,
    lane: "ask",
    kind: "agent_question",
    status: "review_required",
    title: question.question,
    reason: question.why,
    consequence: question.pipelineRunId
      ? QUESTION_CONSEQUENCE[question.type]
      : "Answering this teaches the workspace; nothing is waiting on it.",
    href: `/workspaces/${workspaceId}?question=${question.id}`,
    campaignId: null,
    campaignName: null,
    dueAt: null,
    createdAt: question.createdAt,
    question,
  };
}

/** Deep links for the setup steps, mirroring the checklist targets. */
const SETUP_META: Record<SetupChecklistItem, { title: string; path: string; reason: string }> = {
  brain_reviewed: {
    title: "Review your Brain",
    path: "/brain",
    reason: "Your GTM memory has not been reviewed since it was drafted.",
  },
  channel_connected: {
    title: "Connect a channel",
    path: "/connectors",
    reason: "No publishing channel is connected yet.",
  },
  first_campaign: {
    title: "Create your first campaign",
    path: "/campaigns",
    reason: "No campaign exists yet.",
  },
  first_approval: {
    title: "Approve your first draft",
    path: "/review",
    reason: "Nothing has been approved yet.",
  },
  insights_live: {
    title: "Turn on insights",
    path: "/connectors",
    reason: "Connect a channel with analytics to see what worked.",
  },
  team_invited: {
    title: "Invite your team",
    path: "/team",
    reason: "You are the only member of this workspace.",
  },
};

const SETUP_ORDER: SetupChecklistItem[] = [
  "brain_reviewed",
  "channel_connected",
  "first_campaign",
  "first_approval",
  "insights_live",
  "team_invited",
];

/**
 * The unmet setup steps, as feed items (D-70.9). Folding them in is what lets
 * `next-action` stop ranking: the checklist is still *state* the UI shows as
 * progress, but the thing a founder should do about it now competes for
 * attention in the same ordered list as everything else, at the bottom.
 */
function setupItems(db: Db, workspaceId: string, now: number): AgentInboxItem[] {
  const state = getNextActionState(db, workspaceId);
  const items: AgentInboxItem[] = [];
  for (const key of SETUP_ORDER) {
    if (state.checklist[key]) continue;
    const meta = SETUP_META[key];
    items.push({
      id: `setup:${key}`,
      lane: "notify",
      kind: "setup_task",
      status: "setup_required",
      title: meta.title,
      reason: meta.reason,
      consequence: "Tuezday cannot run the full loop until this is done.",
      href: `/workspaces/${workspaceId}${meta.path}`,
      campaignId: null,
      campaignName: null,
      dueAt: null,
      // Setup steps have no natural timestamp; the checklist order is their
      // order, and `now` keeps them stable at the bottom of their tier.
      createdAt: now,
      question: null,
    });
  }
  return items;
}

export interface InboxFeedOptions {
  limit?: number;
  now?: number;
}

/**
 * The one ranked feed. Everything a founder is shown as "what needs you" comes
 * from here — including the ask lane, which nothing else in the product knows
 * how to rank.
 */
export function buildAgentInboxFeed(
  db: Db,
  workspaceId: string,
  options: InboxFeedOptions = {},
): AgentInboxFeed {
  const now = options.now ?? Date.now();
  const items: AgentInboxItem[] = [
    ...collectPriorityItems(db, workspaceId, now).map(laned),
    ...listAgentQuestions(db, workspaceId, { status: "open" }).map((question) =>
      questionItem(workspaceId, question),
    ),
    ...setupItems(db, workspaceId, now),
  ];

  const ranked = rankInboxItems(items, now);
  // Counts describe the whole feed, not the page — a lane badge that shrank
  // because of a limit would be lying about how much is waiting.
  const counts = { notify: 0, ask: 0, review: 0 };
  for (const item of ranked) counts[item.lane] += 1;

  const bounded = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return {
    items: ranked.slice(0, bounded),
    counts,
    checklist: checklistProgress(getNextActionState(db, workspaceId)),
    generatedAt: now,
  };
}

/**
 * The compatibility projection (D-70.8): the same items, in the same order, as
 * before Sprint 70 — the ask lane and the setup steps removed, and the lane
 * discriminator dropped. `/priorities` and the copilot's queue tool read this.
 */
export function listWorkspacePriorities(
  db: Db,
  workspaceId: string,
  limit: number = DEFAULT_LIMIT,
): PriorityQueue {
  const now = Date.now();
  const bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const items = rankInboxItems(
    collectPriorityItems(db, workspaceId, now).map(laned),
    now,
  )
    .slice(0, bounded)
    .map(({ lane: _lane, question: _question, ...item }) => item as PriorityItem);
  return { items, generatedAt: now };
}
