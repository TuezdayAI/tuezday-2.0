import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { drafts, workspaces } from "../src/db/schema";
import { applyDraftAction, getDraft } from "../src/services/drafts";
import { listPreferenceEdits, listUndigestedEdits } from "../src/services/preference-edits";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN = { userId: null, label: "founder", human: true };
const SYSTEM = { userId: null, label: "system", human: false };

const ORIGINAL =
  "Pricing pages are broken. Should you charge per seat? Here is what we learned shipping usage-based billing to 40 customers.";

async function fixture(): Promise<{ db: Db; draftId: string }> {
  const db = createTestDb();
  await db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Capture", createdAt: 1, updatedAt: 1 })
    .run();
  const draftId = "22222222-2222-4222-8222-222222222222";
  await db.insert(drafts)
    .values({
      id: draftId,
      workspaceId: WORKSPACE_ID,
      taskType: "signal_response",
      channel: "linkedin",
      originalContent: ORIGINAL,
      content: ORIGINAL,
      state: "pending_review",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return { db, draftId };
}

describe("preference capture (Sprint 68)", () => {
  it("captures a human edit with both sides of the diff", async () => {
    const { db, draftId } = await fixture();
    const draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    await applyDraftAction(
      db,
      draft,
      "edit",
      HUMAN,
      "We shipped usage-based billing to 40 customers. Here is what per-seat pricing hid from us.",
    );

    const edits = await listPreferenceEdits(db, WORKSPACE_ID);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.source).toBe("draft_edit");
    expect(edits[0]!.beforeContent).toBe(ORIGINAL);
    expect(edits[0]!.afterContent).toContain("per-seat pricing hid");
    expect(edits[0]!.instruction).toBeNull();
    expect(edits[0]!.digestedAt).toBeNull();
    expect(edits[0]!.editDistance).toBeGreaterThan(0);
    expect(edits[0]!.draftId).toBe(draftId);
  });

  it("records the founder's own words when the edit came through the editor", async () => {
    const { db, draftId } = await fixture();
    const draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    await applyDraftAction(
      db,
      draft,
      "edit",
      HUMAN,
      "We shipped usage-based billing to 40 customers and per-seat hid the churn.",
      undefined,
      { instruction: "Never open with a rhetorical question" },
    );

    const [edit] = await listPreferenceEdits(db, WORKSPACE_ID);
    expect(edit!.source).toBe("editor_turn");
    expect(edit!.instruction).toBe("Never open with a rhetorical question");
  });

  it("ignores a machine edit — a system rewrite is not a preference (D-68.2)", async () => {
    const { db, draftId } = await fixture();
    const draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    await applyDraftAction(db, draft, "edit", SYSTEM, "A completely different machine-written post.");
    expect(await listPreferenceEdits(db, WORKSPACE_ID)).toHaveLength(0);
  });

  it("ignores a whitespace-scale correction", async () => {
    const { db, draftId } = await fixture();
    const draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    // One character in a 120-character post is under PREFERENCE_MIN_EDIT_DISTANCE.
    await applyDraftAction(db, draft, "edit", HUMAN, `${ORIGINAL} `);
    expect(await listPreferenceEdits(db, WORKSPACE_ID)).toHaveLength(0);
  });

  it("captures nothing for approvals and rejections — this sprint reads edits (D-68.1)", async () => {
    const { db, draftId } = await fixture();
    const draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    await applyDraftAction(db, draft, "reject", HUMAN, undefined, "Too generic");
    expect(await listPreferenceEdits(db, WORKSPACE_ID)).toHaveLength(0);
  });

  it("captures each successive edit separately, oldest first for extraction", async () => {
    const { db, draftId } = await fixture();
    let draft = (await getDraft(db, WORKSPACE_ID, draftId))!;
    draft = await applyDraftAction(db, draft, "edit", HUMAN, "First rewrite, quite different from it.");
    await applyDraftAction(db, draft, "edit", HUMAN, "Second rewrite, different again from that one.");

    const undigested = await listUndigestedEdits(db, WORKSPACE_ID, 10);
    expect(undigested).toHaveLength(2);
    expect(undigested[0]!.afterContent).toContain("First rewrite");
    expect(undigested[0]!.beforeContent).toBe(ORIGINAL);
    // The second edit's "before" is the first edit's result, not the original —
    // otherwise the second diff would re-teach the first correction.
    expect(undigested[1]!.beforeContent).toContain("First rewrite");
  });
});
