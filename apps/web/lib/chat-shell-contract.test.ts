import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const DRAWER = "src/components/copilot/copilot.tsx";

// ---------------------------------------------------------------------------
// The chat drawer's shell contract (Sprint 76). These assert the wiring the
// unit tests cannot see: that the drawer streams rather than polls, that it
// renders the trace link and the citations the PRD makes mandatory, and that
// the Sprint 42 write path really is gone from the surface.
// ---------------------------------------------------------------------------

describe("chat drawer shell contract (Sprint 76)", () => {
  it("streams the turn instead of awaiting a whole answer", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain('Accept: "text/event-stream"');
    expect(drawer).toContain("readChatStream");
    // Deltas render as they arrive — a spinner over a twelve-step run is what
    // this sprint exists to stop.
    expect(drawer).toContain('case "text_delta"');
    expect(drawer).toContain('case "tool_call_start"');
  });

  it("renders the citations and the trace link the PRD requires", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("CitationChip");
    expect(drawer).toContain("citationHref");
    // "the Agent Inspector shows which tools produced it"
    expect(drawer).toContain("agentRunHref");
    expect(drawer).toContain("How it answered");
  });

  it("shows what a turn and the thread cost", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("formatCost");
    expect(drawer).toContain("threadBudgetView");
  });

  it("surfaces the thread's goal and its compactions", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("scopeGoal");
    // A folded conversation is visible in the transcript, never silent.
    expect(drawer).toContain('m.role === "compaction"');
  });

  it("blocks the composer once the thread cap is spent, rather than failing on send", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("budget?.exhausted");
  });

  it("refetches the server transcript when a stream drops mid-turn", () => {
    const drawer = read(DRAWER);
    // The partial we streamed is not authoritative; the persisted rows are.
    expect(drawer).toContain("if (!settled) await loadSession(sessionId)");
  });

  it("has no trace of the Sprint 42 propose/confirm surface", () => {
    const drawer = read(DRAWER);
    expect(drawer).not.toContain("ProposalCard");
    expect(drawer).not.toContain("confirmToken");
    expect(drawer).not.toContain("/confirm");
    expect(drawer).not.toContain("resolveProposal");
  });

  it("tells the founder plainly that it cannot change anything", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("read-only");
  });
});

describe("task-type pickers exclude the conversational task (D-76.6)", () => {
  const PICKERS = [
    "app/workspaces/[id]/sandbox/page.tsx",
    "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx",
  ] as const;

  it("iterate GENERATION_TASK_TYPES, never the full list", () => {
    for (const file of PICKERS) {
      const source = read(file);
      expect(source, file).toContain("GENERATION_TASK_TYPES");
      // A picker offering "gtm_conversation" would invite a founder to
      // generate a conversation, which is not a thing.
      expect(source, file).not.toMatch(/\{TASK_TYPES\.map/);
    }
  });

  it("still label the conversational task, for surfaces that display stored data", () => {
    // /learning and /resolver read a taskType off a row; an unlabelled value
    // renders as undefined.
    for (const file of ["app/workspaces/[id]/learning/page.tsx", "app/workspaces/[id]/resolver/page.tsx"]) {
      expect(read(file), file).toContain("gtm_conversation:");
    }
  });
});
