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
  });

  it("uses optimistic concurrency and preserves recoverable revision input", () => {
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("expectedDraftUpdatedAt");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain("Try again on latest");
    expect(source).toContain("requestAnimationFrame");
  });
});
