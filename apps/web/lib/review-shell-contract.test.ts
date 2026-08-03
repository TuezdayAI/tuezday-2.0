import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reviewPage = readFileSync(
  new URL("../app/workspaces/[id]/review/page.tsx", import.meta.url),
  "utf8",
);
const approvalsRoute = readFileSync(
  new URL("../app/workspaces/[id]/approvals/page.tsx", import.meta.url),
  "utf8",
);
const inboxRoute = readFileSync(
  new URL("../app/workspaces/[id]/inbox/page.tsx", import.meta.url),
  "utf8",
);
const queueSource = readFileSync(
  new URL("../app/workspaces/[id]/review/_components/approvals-queue.tsx", import.meta.url),
  "utf8",
);
const reviewWorkspaceSource = readFileSync(
  new URL("./review-workspace.ts", import.meta.url),
  "utf8",
);

describe("review workspace shell contract", () => {
  it("drives the active tab from the URL through the shared parser", () => {
    expect(reviewPage).toContain("reviewTab(");
    expect(reviewPage).toContain("reviewHref(");
    expect(reviewPage).toContain("aria-current");
  });

  it("renders the editor from the draft query while keeping Review canonical", () => {
    expect(queueSource).toContain('searchParams.get("draft")');
    expect(queueSource).toContain("<ConversationalEditor");
    expect(queueSource).toContain("reviewHref");
    expect(queueSource).not.toContain("function renderDetail");
  });

  it("preserves queue scope while navigating drafts", () => {
    expect(reviewWorkspaceSource).toContain("draft");
    expect(reviewWorkspaceSource).toContain("campaign");
    expect(reviewWorkspaceSource).toContain("channel");
    expect(reviewWorkspaceSource).toContain("state");
    expect(queueSource).toContain("queueNeighbors");
  });

  // Sprint 52 — approving a post also authorizes its publication. This queue
  // holds drafts, which carry neither the action kind nor the resolved policy,
  // so the copy stays general rather than promising per card.
  it("states the collapsed publish gate where the approval decision is taken", () => {
    expect(queueSource).toContain("Approving a post also authorizes it to publish");
    expect(queueSource).toContain("it comes back for a separate authorization");
    expect(queueSource).toContain("always need that second decision");
    // No per-draft promise: the queue never claims a specific draft will publish.
    expect(queueSource).not.toMatch(/This draft will publish/i);
    expect(queueSource).not.toMatch(/toast\("Approved and published/);
    // The approval verbs still route through the contracts state machine.
    expect(queueSource).toContain('canTransition(draft.state, "approve")');
  });

  it("mounts both queue surfaces from the review shell", () => {
    expect(reviewPage).toContain("ApprovalsQueue");
    expect(reviewPage).toContain("InboxQueue");
  });

  it("keeps legacy deep links working via param-preserving redirects", () => {
    expect(approvalsRoute).toContain("reviewHref");
    expect(approvalsRoute).toContain('tab: "approvals"');
    expect(inboxRoute).toContain("reviewHref");
    expect(inboxRoute).toContain('tab: "inbox"');
  });
});
