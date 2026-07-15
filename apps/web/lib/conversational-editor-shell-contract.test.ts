import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(
  root,
  "app/workspaces/[id]/review/_components/conversational-editor.tsx",
);

describe("conversational editor shell contract", () => {
  it("coordinates Guidance, Preview, and Execution with shared primitives", () => {
    expect(fs.existsSync(sourcePath)).toBe(true);
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("PreviewCard");
    expect(source).toContain("previewKindFor");
    expect(source).toContain("WorkflowStatusBadge");
    expect(source).toContain('aria-label="Guidance"');
    expect(source).toContain('aria-label="Preview"');
    expect(source).toContain('aria-label="Execution"');
    expect(source).toContain('aria-live="polite"');
  });

  it("keeps content and external-action decisions separate", () => {
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("Content decision");
    expect(source).toContain("External action authorization");
    expect(source).not.toContain("Approve and publish");
    expect(source).toContain("/carousel");
    expect(source).toContain("Generate carousel");
  });

  it("proposes publications with a retained request key and links to authorization", () => {
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("Prepare publication");
    expect(source).toContain("publishEligibility");
    expect(source).toContain("publishActionPayload");
    expect(source).toContain("idempotencyKey");
    expect(source).toMatch(/drafts\/\$\{draftId\}\/publish/);
    expect(source).toContain("externalActionWorkflowStatus");
    expect(source).toContain("policyExplanation");
    expect(source).toContain("Open authorization");
    // The deferred-slice note is gone; the editor never authorizes in place.
    expect(source).not.toContain("next Stage 3 slice");
    expect(source).not.toMatch(/external-actions\/[^"]*\/(authorize|deny)/);
  });

  it("uses optimistic concurrency and preserves recoverable revision input", () => {
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("expectedDraftUpdatedAt");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain("Try again on latest");
    expect(source).toContain("requestAnimationFrame");
  });

  it("is mounted by Review with queue navigation callbacks", () => {
    const queue = fs.readFileSync(
      path.join(root, "app/workspaces/[id]/review/_components/approvals-queue.tsx"),
      "utf8",
    );
    expect(queue).toContain("<ConversationalEditor");
    expect(queue).toContain("previousId");
    expect(queue).toContain("nextId");
    expect(queue).toContain("onNavigate");
    expect(queue).toContain("onClose");
  });
});
