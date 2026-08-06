import { describe, expect, it } from "vitest";
import {
  AGENT_INBOX_ITEM_KINDS,
  type AgentInboxFeed,
  type AgentInboxItem,
  type AgentQuestion,
} from "@tuezday/contracts";
import {
  answerCta,
  answerOptions,
  inboxIsClear,
  inboxItemView,
  itemsInLane,
  laneMeta,
  questionTypeLabel,
  suggestedRule,
  LANE_ORDER,
} from "./agent-inbox-view";

const RUN_ID = "99999999-9999-4999-8999-999999999999";

function question(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: "q-1",
    workspaceId: "ws-1",
    agentRunId: RUN_ID,
    pipelineRunId: "run-1",
    stepKey: "draft",
    type: "missing_permission",
    question: "May we name the investors?",
    why: "The plan does not say.",
    options: ["Yes, name them", "No, keep them out"],
    status: "open",
    answer: null,
    answeredByUserId: null,
    answeredByLabel: null,
    answeredAt: null,
    ruleId: null,
    createdAt: 1,
    ...overrides,
  } as AgentQuestion;
}

function item(overrides: Partial<AgentInboxItem> = {}): AgentInboxItem {
  return {
    id: "i-1",
    lane: "review",
    kind: "content_review",
    status: "review_required",
    title: "A draft is waiting",
    reason: "This draft is waiting for your review.",
    consequence: "It cannot be scheduled until you decide.",
    href: "/workspaces/ws-1/review",
    campaignId: null,
    campaignName: null,
    dueAt: null,
    createdAt: 1,
    question: null,
    ...overrides,
  } as AgentInboxItem;
}

function feed(items: AgentInboxItem[]): AgentInboxFeed {
  const counts = { notify: 0, ask: 0, review: 0 };
  for (const entry of items) counts[entry.lane] += 1;
  return {
    items,
    counts,
    checklist: { done: 6, total: 6, complete: true },
    generatedAt: 1,
  };
}

describe("agent inbox view (Sprint 70)", () => {
  it("has copy for every lane and every kind the API can send", () => {
    for (const lane of LANE_ORDER) expect(laneMeta(lane).title.length).toBeGreaterThan(0);
    for (const kind of AGENT_INBOX_ITEM_KINDS) {
      // A kind with no presentation entry renders as a blank card, which is
      // how a real item goes silently missing from Home.
      expect(inboxItemView(item({ kind })).label, kind).toBeTruthy();
    }
  });

  it("stacks the stuck agent above decisions, and decisions above news", () => {
    expect(LANE_ORDER).toEqual(["ask", "review", "notify"]);
  });

  it("splits the one feed by lane without reordering it", () => {
    const first = item({ id: "a", lane: "ask", kind: "agent_question", question: question() });
    const second = item({ id: "b" });
    const third = item({ id: "c", lane: "notify", kind: "campaign_risk" });
    const built = feed([first, second, third]);
    expect(itemsInLane(built, "ask").map((entry) => entry.id)).toEqual(["a"]);
    expect(itemsInLane(built, "review").map((entry) => entry.id)).toEqual(["b"]);
    expect(itemsInLane(built, "notify").map((entry) => entry.id)).toEqual(["c"]);
  });

  it("says whether answering restarts something", () => {
    expect(answerCta(question())).toContain("continue the run");
    // Nothing is suspended, so promising to continue a run would be a lie.
    expect(answerCta(question({ pipelineRunId: null }))).toBe("Answer");
  });

  it("frames the question in the platform's voice, not the model's", () => {
    // The question text is model-written and may be attacker-influenced; the
    // label around it is ours.
    expect(questionTypeLabel(question())).toBe("May it?");
    expect(questionTypeLabel(question({ type: "policy_escalation" }))).toContain("remit");
  });

  it("offers the agent's options without ever making them the only way to answer", () => {
    expect(answerOptions(question())).toEqual(["Yes, name them", "No, keep them out"]);
    expect(answerOptions(question({ options: [] }))).toEqual([]);
  });

  it("prefills a rule from the founder's own words", () => {
    expect(suggestedRule(question(), "Never name investors before the round is public.")).toBe(
      "Never name investors before the round is public.",
    );
    // Too short to stand alone as a rule: keep the question for context rather
    // than store "No." as something to steer generation with.
    expect(suggestedRule(question(), "No.")).toContain("May we name the investors?");
  });

  it("treats an empty feed as all-clear", () => {
    expect(inboxIsClear(feed([]))).toBe(true);
    expect(inboxIsClear(feed([item()]))).toBe(false);
  });
});
