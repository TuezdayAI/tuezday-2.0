import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvalDecisionSchema, draftSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { approvalDecisions, drafts as draftsTable } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { mintActionToken } from "../src/notifications/tokens";
import { createApiKey } from "../src/services/api-keys";
import { draftApprovalFingerprint } from "../src/services/draft-approval-fingerprint";
import {
  applyDraftAction,
  getDraft,
  humanApprovalCoveringDraft,
  submitAutomaticDraft,
} from "../src/services/drafts";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeGateway: LlmGateway = {
  async generate() {
    return { text: "Generated post text.", model: "fake-model", provider: "fake", durationMs: 5 };
  },
};

/** The worker's identity — no user behind it. Sprint 52 D2a: never collapses Gate 2. */
const SYSTEM_ACTOR = { userId: null, label: "system", human: false };

describe("approval gate API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let generationId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeGateway });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Gatekeeper" } })
    ).json().id;
    generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function submit() {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
    });
  }

  async function act(draftId: string, action: string, payload?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/${action}`,
      ...(payload ? { payload } : {}),
    });
  }

  describe("submit", () => {
    it("creates a pending_review draft from a generation", async () => {
      const res = await submit();
      expect(res.statusCode).toBe(201);
      const draft = res.json();
      expect(draftSchema.safeParse(draft).success).toBe(true);
      expect(draft.state).toBe("pending_review");
      expect(draft.content).toBe("Generated post text.");
      expect(draft.originalContent).toBe("Generated post text.");
      expect(draft.sourceGenerationId).toBe(generationId);
      expect(draft.taskType).toBe("linkedin_post");
    });

    it("logs the submit decision", async () => {
      const draft = (await submit()).json();
      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      expect(detail.decisions).toHaveLength(1);
      expect(detail.decisions[0]).toMatchObject({
        action: "submit",
        fromState: "draft",
        toState: "pending_review",
        actor: "founder",
      });
    });

    it("refuses submitting the same generation twice", async () => {
      await submit();
      const res = await submit();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("already_submitted");
    });

    it("returns 404 for an unknown generation", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/7c9e6679-7425-40de-944b-e07fc1f90ae7/submit`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("edit", () => {
    it("updates content, sets state edited, keeps original, logs snapshot", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "edit", { content: "Better post text." });
      expect(res.statusCode).toBe(200);
      const edited = res.json();
      expect(edited.state).toBe("edited");
      expect(edited.content).toBe("Better post text.");
      expect(edited.originalContent).toBe("Generated post text.");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      const editDecision = detail.decisions.find((d: { action: string }) => d.action === "edit");
      expect(editDecision.contentSnapshot).toBe("Better post text.");
    });

    it("allows re-editing an edited draft", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      const res = await act(draft.id, "edit", { content: "v3" });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("v3");
    });

    it("rejects empty content", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "edit", { content: "" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("transitions", () => {
    it("approves from pending_review", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe("approved");
    });

    it("approves from edited keeping the edited content", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "Edited then approved." });
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("Edited then approved.");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      const approval = detail.decisions.find((d: { action: string }) => d.action === "approve");
      expect(approval.fromState).toBe("edited");
    });

    it("rejects from pending_review", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "reject");
      expect(res.json().state).toBe("rejected");
    });

    it("resubmits an edited draft back to pending_review", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      const res = await act(draft.id, "resubmit");
      expect(res.json().state).toBe("pending_review");
    });

    it("refuses editing an approved draft with 409", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const res = await act(draft.id, "edit", { content: "too late" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("invalid_transition");
      expect(res.json().message).toContain("approved");
    });

    it("refuses approving a rejected draft with 409", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "reject");
      const res = await act(draft.id, "approve");
      expect(res.statusCode).toBe(409);
    });

    it("refuses resubmitting a pending_review draft with 409", async () => {
      const draft = (await submit()).json();
      const res = await act(draft.id, "resubmit");
      expect(res.statusCode).toBe(409);
    });

    it("returns 404 for an unknown draft", async () => {
      const res = await act("7c9e6679-7425-40de-944b-e07fc1f90ae7", "approve");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("queue", () => {
    it("lists drafts newest first with optional state filter", async () => {
      const first = (await submit()).json();
      const gen2 = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "cold_email_opener", channel: "email" },
        })
      ).json();
      const second = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen2.id}/submit`,
        })
      ).json();
      await act(first.id, "approve");

      const all = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe(second.id);

      const approved = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts?state=approved` })
      ).json();
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe(first.id);
    });

    it("rejects an invalid state filter", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/drafts?state=bogus`,
      });
      expect(res.statusCode).toBe(400);
    });

    it("decision log is oldest first and complete", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      await act(draft.id, "resubmit");
      await act(draft.id, "approve");

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      expect(detail.decisions.map((d: { action: string }) => d.action)).toEqual([
        "submit",
        "edit",
        "resubmit",
        "approve",
      ]);
    });
  });

  // Sprint 52: the approval decision records exactly what a human approved, so
  // a later publish can tell whether the approval still stands.
  describe("approval content fingerprint", () => {
    function decisionRows(draftId: string) {
      return db
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.draftId, draftId))
        .all();
    }

    function decisionFor(draftId: string, action: string) {
      const rows = decisionRows(draftId).filter((row) => row.action === action);
      const row = rows[rows.length - 1];
      if (!row) throw new Error(`no ${action} decision for draft ${draftId}`);
      return row;
    }

    async function seedAutomaticDraft(autoApprove: boolean) {
      return submitAutomaticDraft(
        db,
        {
          workspaceId,
          sourceGenerationId: generationId,
          taskType: "signal_response",
          channel: "linkedin",
          personaId: null,
          content: "Auto-drafted post text.",
          automationKey: `automation:v1:${workspaceId}:${autoApprove}`,
          autoApprove,
        },
        SYSTEM_ACTOR,
      );
    }

    it("is exposed by the contracts schema as a nullable sha256 hex string", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts/${draft.id}` })
      ).json();
      for (const decision of detail.decisions) {
        expect(approvalDecisionSchema.safeParse(decision).success).toBe(true);
      }
    });

    it("a human approve stores the fingerprint of the approved content", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");

      const row = decisionFor(draft.id, "approve");
      expect(row.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row.contentFingerprint).toBe(
        draftApprovalFingerprint({ id: draft.id, content: draft.content, mediaJson: null }),
      );
      expect(row.actorId).not.toBeNull();
    });

    it("a human approve of an edited draft fingerprints the edited content", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "Edited then approved." });
      await act(draft.id, "approve");

      expect(decisionFor(draft.id, "approve").contentFingerprint).toBe(
        draftApprovalFingerprint({
          id: draft.id,
          content: "Edited then approved.",
          mediaJson: null,
        }),
      );
    });

    it("includes the draft's media in the fingerprint", async () => {
      const draft = (await submit()).json();
      const mediaJson = JSON.stringify([{ url: "https://cdn.test/a.png", type: "image" }]);
      db.update(draftsTable).set({ mediaJson }).where(eq(draftsTable.id, draft.id)).run();
      await act(draft.id, "approve");

      const stored = decisionFor(draft.id, "approve").contentFingerprint;
      expect(stored).toBe(
        draftApprovalFingerprint({ id: draft.id, content: draft.content, mediaJson }),
      );
      expect(stored).not.toBe(
        draftApprovalFingerprint({ id: draft.id, content: draft.content, mediaJson: null }),
      );
    });

    it("a system approve stores no fingerprint (D2a)", async () => {
      const commit = await seedAutomaticDraft(true);
      expect(commit.draft.state).toBe("approved");

      const row = decisionFor(commit.draft.id, "approve");
      expect(row.actorId).toBeNull();
      expect(row.contentFingerprint).toBeNull();
    });

    it("stores no fingerprint for submit, edit, resubmit or reject", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "edit", { content: "v2" });
      await act(draft.id, "resubmit");
      await act(draft.id, "edit", { content: "v3" });
      await act(draft.id, "reject");

      for (const row of decisionRows(draft.id)) {
        expect(row.action).not.toBe("approve");
        expect(row.contentFingerprint).toBeNull();
      }
    });

    // D2c: a signed one-time approve link is a human decision. The public API
    // key is a machine credential and is not.
    it("the email one-click approve link stores a fingerprint", async () => {
      const draft = (await submit()).json();
      const token = mintActionToken(db, workspaceId, draft.id, "approve");

      const res = await app.inject({ method: "GET", url: `/a/${token}` });
      expect(res.statusCode).toBe(200);
      expect(getDraft(db, workspaceId, draft.id)?.state).toBe("approved");

      const row = decisionFor(draft.id, "approve");
      expect(row.actorId).toBeNull();
      expect(row.contentFingerprint).toBe(
        draftApprovalFingerprint({ id: draft.id, content: draft.content, mediaJson: null }),
      );
    });

    it("the Telegram approve button stores a fingerprint", async () => {
      const draft = (await submit()).json();
      const token = mintActionToken(db, workspaceId, draft.id, "approve");

      const res = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        payload: { callback_query: { id: "cb-1", data: `approve:${token}` } },
      });
      expect(res.statusCode).toBe(200);
      expect(getDraft(db, workspaceId, draft.id)?.state).toBe("approved");

      const row = decisionFor(draft.id, "approve");
      expect(row.actorId).toBeNull();
      expect(row.contentFingerprint).toBe(
        draftApprovalFingerprint({ id: draft.id, content: draft.content, mediaJson: null }),
      );
    });

    it("a public-API approve stores no fingerprint — a machine credential is not a human", async () => {
      const draft = (await submit()).json();
      const apiKey = createApiKey(db, workspaceId, {
        name: "drafts",
        scopes: ["drafts:write"],
      }).rawKey;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/drafts/${draft.id}/approve`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);

      const row = decisionFor(draft.id, "approve");
      expect(row.contentFingerprint).toBeNull();
    });

    it("keeps the draft row itself unchanged apart from state and content", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const after = getDraft(db, workspaceId, draft.id);
      expect(after?.state).toBe("approved");
      expect(after?.content).toBe(draft.content);
    });

    it("scopes decisions to the draft's workspace", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const scoped = db
        .select()
        .from(approvalDecisions)
        .where(
          and(
            eq(approvalDecisions.workspaceId, workspaceId),
            eq(approvalDecisions.draftId, draft.id),
            eq(approvalDecisions.action, "approve"),
          ),
        )
        .all();
      expect(scoped).toHaveLength(1);
      expect(scoped[0]?.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // Sprint 52: "was this exact content approved by a human, and does that
  // approval still stand?" — the lookup a later publish consults.
  describe("humanApprovalCoveringDraft", () => {
    it("returns the fingerprint and the approver of a human approval", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");

      expect(humanApprovalCoveringDraft(db, workspaceId, draft.id)).toEqual({
        fingerprint: draftApprovalFingerprint({
          id: draft.id,
          content: draft.content,
          mediaJson: null,
        }),
        // The signed-in founder — the identity a collapsed publish is
        // attributed to, so "who authorized this?" has a human answer.
        actor: expect.any(String),
        actorId: expect.any(String),
      });
    });

    it("returns null once the content changed after the approval", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      // `approved` has no edit edge, so drift is written directly — exactly
      // what the fingerprint exists to catch.
      db.update(draftsTable)
        .set({ content: "Rewritten after approval" })
        .where(eq(draftsTable.id, draft.id))
        .run();

      expect(humanApprovalCoveringDraft(db, workspaceId, draft.id)).toBeNull();
    });

    it("returns null once only the media changed after the approval", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      db.update(draftsTable)
        .set({ mediaJson: JSON.stringify([{ url: "https://cdn.test/b.png", type: "image" }]) })
        .where(eq(draftsTable.id, draft.id))
        .run();

      expect(humanApprovalCoveringDraft(db, workspaceId, draft.id)).toBeNull();
    });

    it("returns null for a system approval (D2a)", async () => {
      const commit = submitAutomaticDraft(
        db,
        {
          workspaceId,
          sourceGenerationId: generationId,
          taskType: "signal_response",
          channel: "linkedin",
          personaId: null,
          content: "Auto-drafted post text.",
          automationKey: `automation:v1:${workspaceId}:lookup`,
          autoApprove: true,
        },
        SYSTEM_ACTOR,
      );
      expect(commit.draft.state).toBe("approved");
      expect(humanApprovalCoveringDraft(db, workspaceId, commit.draft.id)).toBeNull();
    });

    it("returns null while the draft is still pending review", async () => {
      const draft = (await submit()).json();
      expect(humanApprovalCoveringDraft(db, workspaceId, draft.id)).toBeNull();
    });

    it("returns null for a rejected draft", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "reject");
      expect(humanApprovalCoveringDraft(db, workspaceId, draft.id)).toBeNull();
    });

    it("returns null for an unknown draft", () => {
      expect(
        humanApprovalCoveringDraft(db, workspaceId, "7c9e6679-7425-40de-944b-e07fc1f90ae7"),
      ).toBeNull();
    });

    it("returns null for a draft in another workspace", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const otherWorkspaceId = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Elsewhere" } })
      ).json().id;
      expect(humanApprovalCoveringDraft(db, otherWorkspaceId, draft.id)).toBeNull();
    });

    it("returns the newest approval when a draft is approved more than once", async () => {
      const draft = (await submit()).json();
      await act(draft.id, "approve");
      const first = humanApprovalCoveringDraft(db, workspaceId, draft.id);

      // The approval state machine has no edge out of `approved` today, so
      // re-open the draft directly to exercise the lookup's ordering. Both
      // approvals land in the same millisecond, which is exactly the tie the
      // lookup has to break deterministically.
      db.update(draftsTable)
        .set({ state: "edited" })
        .where(eq(draftsTable.id, draft.id))
        .run();
      const reopened = getDraft(db, workspaceId, draft.id)!;
      const edited = applyDraftAction(db, reopened, "edit", { userId: "u", label: "founder", human: true }, "v2");
      applyDraftAction(db, edited, "approve", { userId: "u", label: "founder", human: true });

      // Force the worst case: both approvals carry an identical createdAt, so
      // only the insertion-order tie-break can pick the right one.
      db.update(approvalDecisions)
        .set({ createdAt: 1_700_000_000_000 })
        .where(eq(approvalDecisions.draftId, draft.id))
        .run();

      const latest = humanApprovalCoveringDraft(db, workspaceId, draft.id);
      expect(latest?.fingerprint).not.toBe(first?.fingerprint);
      expect(latest?.fingerprint).toBe(
        draftApprovalFingerprint({ id: draft.id, content: "v2", mediaJson: null }),
      );
    });
  });
});
