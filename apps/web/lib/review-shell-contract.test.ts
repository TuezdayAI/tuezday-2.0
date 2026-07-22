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
