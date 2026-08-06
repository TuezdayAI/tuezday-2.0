import { describe, expect, it } from "vitest";
import type { PreferenceEdit, PreferenceRule } from "@tuezday/contracts";
import {
  RULE_STATUS_ORDER,
  actionLabel,
  availableActions,
  editSummary,
  groupByStatus,
  memoryState,
  provenanceLine,
  scopeLabel,
  statusHelp,
  statusLabel,
  statusTone,
} from "./preferences-view";

function rule(overrides: Partial<PreferenceRule> = {}): PreferenceRule {
  return {
    id: "rule-1",
    workspaceId: "ws-1",
    rule: "Never open with a rhetorical question",
    polarity: "avoid",
    scopeTaskType: null,
    scopeChannel: null,
    status: "active",
    origin: "extracted",
    confidence: 85,
    observationCount: 3,
    appliedCount: 4,
    lastObservedAt: 10,
    lastAppliedAt: 20,
    promotedAt: null,
    retiredAt: null,
    createdAt: 1,
    updatedAt: 20,
    ...overrides,
  };
}

function edit(overrides: Partial<PreferenceEdit> = {}): PreferenceEdit {
  return {
    id: "edit-1",
    workspaceId: "ws-1",
    source: "draft_edit",
    sourceId: "decision-1",
    draftId: "draft-1",
    taskType: "signal_response",
    channel: "linkedin",
    beforeContent: "before",
    afterContent: "after",
    instruction: null,
    editDistance: 42.4,
    digestedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("preference view helpers (Sprint 68)", () => {
  it("labels and explains every status", () => {
    for (const status of RULE_STATUS_ORDER) {
      expect(statusLabel(status)).not.toBe(status);
      expect(statusHelp(status).length).toBeGreaterThan(0);
    }
    expect(statusTone("active")).toBe("approved");
    expect(statusTone("disabled")).toBe("rejected");
    expect(statusTone("candidate")).toBe("neutral");
  });

  it("says what a rule governs in the same words the trace uses", () => {
    expect(scopeLabel(rule())).toBe("all tasks");
    expect(scopeLabel(rule({ scopeChannel: "linkedin" }))).toBe("linkedin");
    expect(scopeLabel(rule({ scopeChannel: "linkedin", scopeTaskType: "signal_response" }))).toBe(
      "signal_response on linkedin",
    );
  });

  it("shows how much evidence stands behind a rule, and singularises honestly", () => {
    expect(provenanceLine(rule())).toBe("Learned from 3 of your edits · applied to 4 drafts");
    expect(provenanceLine(rule({ observationCount: 1, appliedCount: 1 }))).toBe(
      "Learned from 1 of your edits · applied to 1 draft",
    );
    // A hand-written rule was not "learned from" anything — saying so would lie.
    expect(provenanceLine(rule({ origin: "manual", appliedCount: 2 }))).toBe(
      "Written by you · applied to 2 drafts",
    );
  });

  it("offers the levers that mean something and none that do not", () => {
    expect(availableActions("candidate")).toEqual(["active", "disabled"]);
    expect(availableActions("active")).toEqual(["disabled"]);
    expect(availableActions("disabled")).toEqual(["active"]);
    // A promoted rule lives in a brain doc now — switching it off here would
    // change nothing, so the button is not offered.
    expect(availableActions("promoted")).toEqual([]);
    expect(actionLabel("disabled")).toBe("Switch off");
    expect(actionLabel("active")).toBe("Turn on");
  });

  it("groups rules by status and hides empty buckets", () => {
    const groups = groupByStatus([
      rule({ id: "a", status: "candidate" }),
      rule({ id: "b", status: "active" }),
      rule({ id: "c", status: "active" }),
    ]);
    expect(groups.map((group) => group.status)).toEqual(["active", "candidate"]);
    expect(groups[0]!.rules).toHaveLength(2);
  });

  it("summarises a captured edit by the founder's words when it has them", () => {
    expect(editSummary(edit())).toBe("signal_response on linkedin · 42% rewritten");
    expect(editSummary(edit({ instruction: "stop hedging" }))).toBe(
      'signal_response on linkedin · "stop hedging"',
    );
  });

  it("tells nothing-captured apart from nothing-learned-yet", () => {
    expect(memoryState([], [])).toBe("empty");
    expect(memoryState([], [edit()])).toBe("pending");
    expect(memoryState([rule()], [edit()])).toBe("learning");
    // Only retired and promoted rules left: there is nothing live to show.
    expect(memoryState([rule({ status: "retired" })], [])).toBe("empty");
  });
});
