import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(
  new URL("../app/workspaces/[id]/pr/page.tsx", import.meta.url),
  "utf8",
);

describe("PR native email shell", () => {
  it("makes governed native pitch send primary and keeps mailto recovery", () => {
    expect(shell).toContain("Send pitch from Tuezday");
    expect(shell).toContain("Send selected pitches from Tuezday");
    expect(shell).toContain("Open in email client");
    expect(shell).toContain("EmailPermissionControl");
    expect(shell).toContain("EmailSendStatus");
  });

  it("retains item-level pitch actions and sends selected drafts independently", () => {
    expect(shell).toContain("/pr/drafts/${draftId}/send");
    expect(shell).toContain("Promise.all");
    expect(shell).not.toContain("external-action-batches");
  });
});
