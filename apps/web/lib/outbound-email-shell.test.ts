import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(
  new URL("../app/workspaces/[id]/outbound/page.tsx", import.meta.url),
  "utf8",
);

describe("outbound native email shell", () => {
  it("offers native send as the primary action with CSV preserved", () => {
    expect(shell).toContain("Send from Tuezday");
    expect(shell).toContain("Send selected from Tuezday");
    expect(shell).toContain("Export approved CSV");
    expect(shell).toContain("EmailPermissionControl");
    expect(shell).toContain("EmailSendStatus");
  });

  it("proposes selected drafts independently before any authorization batch exists", () => {
    expect(shell).toContain("/outbound/drafts/${draftId}/send");
    expect(shell).toContain("Promise.all");
    expect(shell).not.toContain("external-action-batches");
  });
});
