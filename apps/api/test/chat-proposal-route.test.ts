import { beforeEach, describe, expect, it } from "vitest";
import { chatProposalSchema, type ChatProposal } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { drafts } from "../src/db/schema";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import { buildAuthedApp, createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// The confirmation routes (Sprint 78) — the only path in chat that can change
// anything, and the only one a model cannot reach. Asserted end to end through
// the real app so the gate under it is the real one.
// ---------------------------------------------------------------------------

class NoEvidence implements EvidenceStore {
  async health() {
    return { healthy: false };
  }
  async createCollection(n: string) {
    return n;
  }
  async addDocument(_i: AddDocumentInput) {
    return "d";
  }
  async attachDocument() {}
  async deleteDocument() {}
  async search(): Promise<StoreSearchResult[]> {
    return [];
  }
}

const titleStep: ScriptedStep = { text: JSON.stringify({ title: "Funding", goal: "Announce" }) };

/** A turn that proposes a draft, then answers. */
const proposeScript: ScriptedStep[] = [
  titleStep,
  {
    toolCalls: [
      {
        name: "propose_draft",
        arguments: {
          content: "We raised a seed round.",
          channel: "linkedin",
          rationale: "You asked for a funding post.",
        },
      },
    ],
  },
  { text: "There's a draft above for you to confirm." },
];

let db: Db;

async function appWith(script: ScriptedStep[]) {
  const app = await buildAuthedApp({
    db,
    llm: new ScriptedGateway(script),
    evidence: new NoEvidence(),
  });
  const workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })
  ).json().id as string;
  return { app, workspaceId };
}

type App = Awaited<ReturnType<typeof appWith>>["app"];

async function proposeInThread(app: App, workspaceId: string) {
  const sessionId = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions`,
      payload: {},
    })
  ).json().id as string;

  const turn = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
    payload: { message: "Draft a LinkedIn post about our funding" },
  });
  return { sessionId, turn };
}

beforeEach(() => {
  db = createTestDb();
});

describe("a proposal reaches the founder", () => {
  it("comes back on the turn, shaped as the contract says, and is pending", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { turn } = await proposeInThread(app, workspaceId);

    expect(turn.statusCode).toBe(201);
    const proposals = turn.json().proposals as ChatProposal[];
    expect(proposals).toHaveLength(1);
    expect(chatProposalSchema.safeParse(proposals[0]).success).toBe(true);
    expect(proposals[0]!.status).toBe("pending");
    // Nothing exists yet.
    expect(await db.select().from(drafts).all()).toHaveLength(0);
  });

  it("is listed on the thread and on its detail, so a reload does not lose it", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId } = await proposeInThread(app, workspaceId);

    const listed = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}`,
    });
    expect(detail.json().proposals).toHaveLength(1);
  });

  it("streams a proposal frame before the message frame", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const sessionId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/chat/sessions`,
        payload: {},
      })
    ).json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
      headers: { accept: "text/event-stream" },
      payload: { message: "Draft a post" },
    });

    const body = res.body;
    expect(body).toContain("event: proposal");
    expect(body.indexOf("event: proposal")).toBeLessThan(body.indexOf("event: message"));
  });
});

describe("confirming", () => {
  it("puts a draft in the approval queue and says where it went", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId, turn } = await proposeInThread(app, workspaceId);
    const proposalId = (turn.json().proposals as ChatProposal[])[0]!.id;

    const confirmed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals/${proposalId}/confirm`,
    });
    expect(confirmed.statusCode).toBe(200);
    const proposal = confirmed.json() as ChatProposal;
    expect(proposal.status).toBe("confirmed");
    expect(proposal.producedStatus).toBe("pending_review");
    expect(proposal.producedRef).toMatch(/^draft:/);
    expect(proposal.confirmedByUserId).toBeTruthy();

    const stored = await db.select().from(drafts).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe("pending_review");
  });

  it("409s the second click rather than creating a second draft", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId, turn } = await proposeInThread(app, workspaceId);
    const proposalId = (turn.json().proposals as ChatProposal[])[0]!.id;
    const url = `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals/${proposalId}/confirm`;

    await app.inject({ method: "POST", url });
    const again = await app.inject({ method: "POST", url });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_resolved");
    expect(await db.select().from(drafts).all()).toHaveLength(1);
  });

  it("404s an unknown proposal and one from another thread", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId } = await proposeInThread(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals/00000000-0000-4000-8000-000000000000/confirm`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires membership, like every other workspace route", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId, turn } = await proposeInThread(app, workspaceId);
    const proposalId = (turn.json().proposals as ChatProposal[])[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals/${proposalId}/confirm`,
      headers: { authorization: "Bearer not-a-session" },
    });
    expect(res.statusCode).toBe(401);
    expect(await db.select().from(drafts).all()).toHaveLength(0);
  });
});

describe("declining", () => {
  it("resolves the card and creates nothing", async () => {
    const { app, workspaceId } = await appWith(proposeScript);
    const { sessionId, turn } = await proposeInThread(app, workspaceId);
    const proposalId = (turn.json().proposals as ChatProposal[])[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/proposals/${proposalId}/decline`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ChatProposal).status).toBe("declined");
    expect(await db.select().from(drafts).all()).toHaveLength(0);
  });
});
