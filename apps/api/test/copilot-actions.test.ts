import { afterEach, describe, expect, it } from "vitest";
import { chatTurnResultSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { COPILOT_TOOLS } from "../src/services/copilot-tools";
import { COPILOT_ACTION_TOOLS } from "../src/services/copilot-actions";
import { listDrafts } from "../src/services/drafts";
import { getExternalAction } from "../src/services/external-actions";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

// ---------------------------------------------------------------------------
// Sprint 42 Part 2 — gated action execution.
//
// The copilot PROPOSES a write; a human CONFIRMS; the write only ever creates a
// gated item (a draft in pending_review, or an external action parked at
// authorization_required). These tests prove: nothing is written before
// confirm; confirm creates exactly the gated item; a bad token / discard writes
// nothing; and a copilot-initiated action never leaves authorization_required
// even under an autonomous policy (the proposeForReview guarantee).
// ---------------------------------------------------------------------------

interface QueueGateway {
  gw: LlmGateway;
  queue: Array<string | Error>;
}

function queueGateway(): QueueGateway {
  const queue: Array<string | Error> = [];
  const gw: LlmGateway = {
    async generate() {
      const reply = queue.length > 0 ? queue.shift()! : "(idle)";
      if (reply instanceof Error) throw reply;
      return { text: reply, model: "fake", provider: "fake", durationMs: 1 };
    },
  };
  return { gw, queue };
}

async function setup(gw: LlmGateway): Promise<{ app: TuezdayApp; db: Db; workspaceId: string }> {
  const db = createTestDb();
  const app = await buildAuthedApp({ db, llm: gw });
  const workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Actions Co" } })
  ).json().id;
  await app.inject({
    method: "PUT",
    url: `/workspaces/${workspaceId}/brain/voice`,
    payload: { content: "## Tone\nDirect, warm, concrete." },
  });
  return { app, db, workspaceId };
}

async function createSession(app: TuezdayApp, workspaceId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions`,
    payload: { title: "Actions chat" },
  });
  return res.json().id as string;
}

function sendMessage(app: TuezdayApp, workspaceId: string, sessionId: string, message: string) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
    payload: { message },
  });
}

function confirm(
  app: TuezdayApp,
  workspaceId: string,
  sessionId: string,
  confirmToken: string,
  decision: "confirm" | "discard",
) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/confirm`,
    payload: { confirmToken, decision },
  });
}

describe("chat copilot actions (Sprint 42 Part 2)", () => {
  let app: TuezdayApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("draft_content proposes without writing, then commits a pending_review draft on confirm", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"draft_content","args":{"brief":"Announce our funnel feature","channel":"linkedin"}}',
      "Big news: our new funnel view ships today. Here's why it matters…",
    );
    const res = await sendMessage(app, workspaceId, sessionId, "Draft a post announcing the funnel feature");
    expect(res.statusCode).toBe(201);
    const turn = res.json();
    expect(chatTurnResultSchema.safeParse(turn).success).toBe(true);

    // Proposed, not written.
    expect(turn.status).toBe("awaiting_confirmation");
    expect(turn.proposal.toolKind).toBe("draft_content");
    expect(typeof turn.proposal.confirmToken).toBe("string");
    expect(turn.proposal.preview).toContain("funnel view");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);

    // Confirm → exactly one draft in pending_review.
    const done = await confirm(app, workspaceId, sessionId, turn.proposal.confirmToken, "confirm");
    expect(done.statusCode).toBe(201);
    const committed = done.json();
    expect(committed.status).toBe("committed");
    expect(committed.producedRef).toMatch(/^draft:/);

    const drafts = listDrafts(db, workspaceId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.state).toBe("pending_review");
    expect(committed.producedRef).toBe(`draft:${drafts[0]!.id}`);
  });

  it("draft_reply commits a pending_review reply draft on confirm", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"draft_reply","args":{"inboundContent":"Is this GDPR compliant?","channel":"email"}}',
      "Great question — yes, here's how we handle GDPR…",
    );
    const turn = (await sendMessage(app, workspaceId, sessionId, "Draft a reply to this lead")).json();
    expect(turn.status).toBe("awaiting_confirmation");
    expect(turn.proposal.toolKind).toBe("draft_reply");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);

    const committed = (
      await confirm(app, workspaceId, sessionId, turn.proposal.confirmToken, "confirm")
    ).json();
    expect(committed.status).toBe("committed");
    const drafts = listDrafts(db, workspaceId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.state).toBe("pending_review");
    expect(drafts[0]!.taskType).toBe("engagement_reply");
  });

  it("propose_action parks at authorization_required even under an autonomous policy", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    // Autonomous policy would auto-dispatch a normal proposal — proveForReview must not.
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"propose_action","args":{"kind":"send","title":"Note to Enterprise","detail":"Quick note about the funnel launch."}}',
    );
    const turn = (
      await sendMessage(app, workspaceId, sessionId, "Propose sending a note to the Enterprise segment")
    ).json();
    expect(turn.status).toBe("awaiting_confirmation");
    expect(turn.proposal.toolKind).toBe("propose_action");

    const committed = (
      await confirm(app, workspaceId, sessionId, turn.proposal.confirmToken, "confirm")
    ).json();
    expect(committed.status).toBe("committed");
    expect(committed.producedRef).toMatch(/^external_action:/);

    const actionId = committed.producedRef.replace("external_action:", "");
    const action = getExternalAction(db, workspaceId, actionId);
    expect(action).toBeDefined();
    // The copilot NEVER dispatches: parked for a human even under autonomous policy.
    expect(action!.status).toBe("authorization_required");
    expect(["authorized", "dispatching", "succeeded"]).not.toContain(action!.status);
  });

  it("surfaces a policy note when the action requires human authorization", async () => {
    const g = queueGateway();
    let workspaceId: string;
    ({ app, workspaceId } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    // Default workspace policy is human_required → the proposal warns up front.
    g.queue.push(
      '{"tool":"propose_action","args":{"kind":"publish","title":"Post","detail":"Ship it."}}',
    );
    const turn = (await sendMessage(app, workspaceId, sessionId, "Propose publishing this")).json();
    expect(turn.status).toBe("awaiting_confirmation");
    expect(turn.proposal.policyNote).toBeTruthy();
  });

  it("a plain-text 'yes' confirms the pending proposal", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"draft_content","args":{"brief":"A short update","channel":"linkedin"}}',
      "Here's a short update for you.",
    );
    const turn = (await sendMessage(app, workspaceId, sessionId, "Draft a short update")).json();
    expect(turn.status).toBe("awaiting_confirmation");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);

    const done = (await sendMessage(app, workspaceId, sessionId, "yes")).json();
    expect(done.status).toBe("committed");
    expect(listDrafts(db, workspaceId)).toHaveLength(1);
  });

  it("a wrong confirm token writes nothing", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"draft_content","args":{"brief":"Nope","channel":"linkedin"}}',
      "Draft body.",
    );
    await sendMessage(app, workspaceId, sessionId, "Draft something");
    const bad = (await confirm(app, workspaceId, sessionId, "not-the-token", "confirm")).json();
    expect(bad.status).toBe("answered");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);
  });

  it("discarding a proposal writes nothing", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"draft_content","args":{"brief":"Maybe","channel":"linkedin"}}',
      "Draft body.",
    );
    const turn = (await sendMessage(app, workspaceId, sessionId, "Draft something")).json();
    const done = (
      await confirm(app, workspaceId, sessionId, turn.proposal.confirmToken, "discard")
    ).json();
    expect(done.status).toBe("answered");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);
  });

  it("a read-only turn with actions enabled never writes", async () => {
    const g = queueGateway();
    let workspaceId: string;
    let db: Db;
    ({ app, workspaceId, db } = await setup(g.gw));
    const sessionId = await createSession(app, workspaceId);

    g.queue.push(
      '{"tool":"search_brain","args":{"query":"tone"}}',
      "Your voice is direct, warm, and concrete.",
    );
    const turn = (await sendMessage(app, workspaceId, sessionId, "What's our voice?")).json();
    expect(turn.status).toBe("answered");
    expect(listDrafts(db, workspaceId)).toHaveLength(0);
  });

  it("guardrail: the read and write registries are disjoint and structurally separate", () => {
    const readNames = new Set(COPILOT_TOOLS.map((t) => t.name));
    const writeNames = new Set(COPILOT_ACTION_TOOLS.map((t) => t.name));
    // No name appears in both registries.
    for (const n of writeNames) expect(readNames.has(n)).toBe(false);
    // Read tools have no commit path; write tools have both propose + commit.
    for (const t of COPILOT_TOOLS) expect("commit" in t).toBe(false);
    for (const t of COPILOT_ACTION_TOOLS) {
      expect(typeof t.propose).toBe("function");
      expect(typeof t.commit).toBe("function");
    }
    // The write whitelist is exactly the three launch tools.
    expect([...writeNames].sort()).toEqual(["draft_content", "draft_reply", "propose_action"]);
  });
});
