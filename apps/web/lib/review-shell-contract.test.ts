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

describe("review workspace shell contract", () => {
  it("drives the active tab from the URL through the shared parser", () => {
    expect(reviewPage).toContain("reviewTab(");
    expect(reviewPage).toContain('"?tab=approvals"');
    expect(reviewPage).toContain('"?tab=inbox"');
    expect(reviewPage).toContain("aria-current");
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
