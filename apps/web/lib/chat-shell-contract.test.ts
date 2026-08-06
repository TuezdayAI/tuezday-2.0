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
    // Sprint 78 adds a second trigger: a proposal frame arrives before the
    // message it belongs to, so the client's copy has no messageId until the
    // refetch.
    expect(drawer).toContain("if (!settled || sawProposal) await loadSession(sessionId)");
  });

  it("renders the confirmation card and both of its decisions (Sprint 78)", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("ProposalCard");
    expect(drawer).toContain("proposalsForMessage");
    expect(drawer).toContain('onResolve("confirm")');
    expect(drawer).toContain('onResolve("decline")');
    // The card's own copy comes from the typed intent, not from prose the
    // component invents.
    expect(drawer).toContain("proposal.intent.effect");
  });

  it("warns on a quarantined card without hiding the choice", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("quarantineWarning");
    // The buttons are gated on `isActionable` — the proposal's status — never
    // on whether it was quarantined.
    expect(drawer).toContain("isActionable(proposal)");
    expect(drawer).not.toMatch(/!proposal\.quarantined\s*&&[\s\S]{0,80}Confirm/);
  });

  it("no longer claims chat cannot change anything", () => {
    const drawer = read(DRAWER);
    expect(drawer).not.toContain("it changes nothing");
    // What replaced it is the honest version: it can ask, and you decide.
    expect(drawer).toContain("nothing happens");
    expect(drawer).toContain("until you confirm");
  });
});

describe("chat drawer shell contract (Sprint 77)", () => {
  it("renders records as cards, live and on the persisted message", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("ResultCard");
    expect(drawer).toContain('case "card"');
    // Cards hang off the message, so reopening a thread renders them again.
    expect(drawer).toContain("m.cards.length > 0");
  });

  it("a card's buttons call the routes the dedicated pages call (D-77.3)", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("cardActionRequest");
    // No chat-side approval implementation — the whole claim of D-77.3 is that
    // the request is the SAME one, so `/drafts/:id/approve` must be built by
    // the shared helper and not spelled out here.
    expect(drawer).not.toMatch(/`\/workspaces\/\$\{workspaceId\}\/drafts\//);
  });

  it("shows the diff before an inline edit is saved", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("diffWords");
    expect(drawer).toContain("describeDiff");
    expect(drawer).toContain("hasChanges");
  });

  it("routes an instant command past the model entirely (D-77.4)", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("parseChatCommand");
    expect(drawer).toContain("runInstantCommand");
    expect(drawer).toContain('parsed?.kind === "instant"');
    // A directive command sends only its NAME; the instruction is the API's.
    expect(drawer).toContain('parsed?.kind === "directive" ? { command: parsed.command }');
  });

  it("shows pinned context as removable chips", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("pinsSummary");
    expect(drawer).toContain("Unpin ");
    expect(drawer).toContain("pinIsUntrusted");
  });

  it("turns a pasted link into an untrusted pin rather than raw text", () => {
    const drawer = read(DRAWER);
    expect(drawer).toContain("onPaste");
    expect(drawer).toContain("pastedUrl");
    expect(drawer).toContain('pinEntity("url", url)');
  });
});

describe("the assistant is summonable from anywhere (Sprint 77)", () => {
  it("binds Cmd/Ctrl+K in the workspace layout", () => {
    const layout = read("app/workspaces/[id]/layout.tsx");
    expect(layout).toContain('e.key.toLowerCase() === "k"');
    expect(layout).toContain("e.metaKey || e.ctrlKey");
    expect(layout).toContain("setCopilotOpen((open) => !open)");
  });
});

describe("task labels live in one place (Sprint 78, closing D-76.6)", () => {
  const SURFACES = [
    "app/workspaces/[id]/sandbox/page.tsx",
    "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx",
    "app/workspaces/[id]/learning/page.tsx",
    "app/workspaces/[id]/resolver/page.tsx",
  ] as const;

  it("none of them declares its own label map any more", () => {
    for (const file of SURFACES) {
      const source = read(file);
      expect(source, file).toContain('from "@/lib/task-labels"');
      expect(source, file).not.toMatch(/const TASK_LABELS: Record<TaskType, string> = \{/);
    }
  });

  it("the shared map is total over TaskType, including the conversational one", () => {
    // /learning and /resolver index it with a task type read off a stored row;
    // an unlabelled value renders as undefined.
    const source = read("lib/task-labels.ts");
    expect(source).toContain("Record<TaskType, string>");
    expect(source).toContain("gtm_conversation:");
  });

  it("pickers still iterate GENERATION_TASK_TYPES, never the full list", () => {
    for (const file of [
      "app/workspaces/[id]/sandbox/page.tsx",
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx",
    ]) {
      const source = read(file);
      expect(source, file).toContain("GENERATION_TASK_TYPES");
      expect(source, file).not.toMatch(/\{TASK_TYPES\.map/);
    }
  });
});
