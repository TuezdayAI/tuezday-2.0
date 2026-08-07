import type {
  AgentInboxFeed,
  AgentInboxItem,
  AgentInboxItemKind,
  AgentInboxLane,
  AgentQuestion,
} from "@tuezday/contracts";
import type { IconName } from "@/src/components/ui/icon";

/**
 * How the agent inbox reads (Sprint 70). Presentation only — the API owns lane
 * assignment and ordering, and this file must never re-rank, or Home would once
 * again be showing a different answer from the one the server computed.
 */

const LANE_META: Record<AgentInboxLane, { title: string; blurb: string; empty: string }> = {
  ask: {
    title: "Waiting on you",
    blurb: "An agent stopped and needs an answer before it can carry on.",
    empty: "Nothing is stuck.",
  },
  review: {
    title: "Needs your judgment",
    blurb: "Work that will not move until you decide.",
    empty: "Nothing is waiting for a decision.",
  },
  notify: {
    title: "Worth knowing",
    blurb: "Things that happened, or stopped happening, without needing a decision.",
    empty: "Nothing to report.",
  },
};

export function laneMeta(lane: AgentInboxLane) {
  return LANE_META[lane];
}

/** Lanes in the order Home stacks them: stuck first, then decisions, then news. */
export const LANE_ORDER: AgentInboxLane[] = ["ask", "review", "notify"];

const KIND_META: Record<AgentInboxItemKind, { label: string; icon: IconName; cta: string }> = {
  execution_failure: { label: "Execution failed", icon: "status-rejected", cta: "Resolve failure" },
  stale_action: { label: "Action is stale", icon: "warning", cta: "Review stale action" },
  policy_block: { label: "Action blocked", icon: "warning", cta: "Resolve blocker" },
  authorization: { label: "Authorization required", icon: "status-review", cta: "Open authorization" },
  content_review: { label: "Content review", icon: "review", cta: "Review content" },
  signal_triage: { label: "Signal needs review", icon: "signal", cta: "Review signal" },
  learning_review: { label: "Learning review", icon: "status-learning", cta: "Review learning" },
  connection_health: { label: "Connection lost", icon: "connection-lost", cta: "Reconnect" },
  campaign_risk: { label: "Campaign risk", icon: "campaign-risk", cta: "Review campaign" },
  agent_question: { label: "The agent is asking", icon: "status-review", cta: "Answer" },
  setup_task: { label: "Setup step", icon: "info", cta: "Finish setup" },
};

export function inboxItemView(item: AgentInboxItem) {
  return { ...KIND_META[item.kind], status: item.status, href: item.href, lane: item.lane };
}

export function itemsInLane(feed: AgentInboxFeed, lane: AgentInboxLane): AgentInboxItem[] {
  return feed.items.filter((item) => item.lane === lane);
}

/**
 * What the question is asking for, in the founder's terms. The model writes the
 * question; this writes the frame around it, so an injected question cannot
 * borrow the platform's voice to make itself sound sanctioned (spec §4).
 */
const QUESTION_TYPE_LABEL: Record<AgentQuestion["type"], string> = {
  disambiguation: "Which did you mean?",
  missing_permission: "May it?",
  missing_fact: "It needs a fact",
  policy_escalation: "This goes beyond its remit",
};

export function questionTypeLabel(question: AgentQuestion): string {
  return QUESTION_TYPE_LABEL[question.type];
}

/** Whether answering this restarts something, which is what the button says. */
export function answerCta(question: AgentQuestion): string {
  return question.pipelineRunId ? "Answer and continue the run" : "Answer";
}

/**
 * A one-click answer for each option the agent offered, plus free text. Options
 * are advisory (D-70.12): an empty list is normal and must never leave the
 * founder without a way to answer.
 */
export function answerOptions(question: AgentQuestion): string[] {
  return question.options.slice(0, 4);
}

/** The prefilled rule text when the founder chooses to remember an answer. */
export function suggestedRule(question: AgentQuestion, answer: string): string {
  const trimmed = answer.trim();
  return trimmed.length >= 8 ? trimmed : `${question.question} — ${trimmed}`;
}

/** Lane badge copy: "3" or nothing. Zero is absence, not a zero. */
export function laneCount(feed: AgentInboxFeed, lane: AgentInboxLane): number {
  return feed.counts[lane];
}

export function inboxIsClear(feed: AgentInboxFeed): boolean {
  return feed.items.length === 0;
}
