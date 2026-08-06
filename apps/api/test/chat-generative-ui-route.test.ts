import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chatCardSchema,
  chatPinSchema,
  chatSessionDetailSchema,
  type ChatCard,
  type ChatPin,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import { drafts } from "../src/db/schema";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import { buildAuthedApp, createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// The Sprint 77 routes, end to end through the real app.
//
// The PRD's acceptance case is the first test: asking for drafts returns
// interactive cards, and approving one from a card writes the SAME
// decision-log record as approving it on /review — necessarily, because it is
// the same route.
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

const titleStep: ScriptedStep = { text: JSON.stringify({ title: "Queue", goal: "" }) };

/** A turn that reads the approval queue, then answers. */
const listDraftsScript: ScriptedStep[] = [
  titleStep,
  { toolCalls: [{ name: "list_drafts", arguments: { state: "pending_review" } }] },
  { text: "One draft is waiting." },
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

async function session(app: App, workspaceId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/chat/sessions`,
    payload: {},
  });
  return res.json().id as string;
}

/**
 * A draft sitting in the approval queue. Seeded directly rather than generated,
 * so the scripted gateway's steps stay dedicated to the turn under test — the
 * claim here is about the APPROVE route, which is entered through the app.
 */
function pendingDraft(workspaceId: string): string {
  const id = randomUUID();
  db.insert(drafts)
    .values({
      id,
      workspaceId,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: "We raised a seed round.",
      content: "We raised a seed round.",
      state: "pending_review",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return id;
}

beforeEach(() => {
  db = createTestDb();
});

describe("cards reach the founder and act (the PRD's acceptance case)", () => {
  it("a turn returns draft cards with the approve action on them", async () => {
    const { app, workspaceId } = await appWith(listDraftsScript);
    const draftId = pendingDraft(workspaceId);
    const sessionId = await session(app, workspaceId);

    const turn = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
      payload: { message: "What's waiting for me?" },
    });
    expect(turn.statusCode).toBe(201);

    const cards = turn.json().cards as ChatCard[];
    expect(cards).toHaveLength(1);
    expect(chatCardSchema.safeParse(cards[0]).success).toBe(true);
    expect(cards[0]).toMatchObject({ kind: "draft", ref: `draft:${draftId}` });
    expect(cards[0]!.actions).toContain("approve");

    // Persisted on the message, so reopening the thread renders them again.
    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}`,
    });
    const parsed = chatSessionDetailSchema.parse(detail.json());
    const assistant = parsed.messages.find((m) => m.role === "assistant" && m.cards.length > 0);
    expect(assistant?.cards[0]!.ref).toBe(`draft:${draftId}`);
  });

  it("approving from a card writes the same decision the review page writes", async () => {
    const { app, workspaceId } = await appWith(listDraftsScript);
    const draftId = pendingDraft(workspaceId);

    // The exact request the card issues (apps/web/lib/chat-card-view.ts).
    const approved = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/drafts/${draftId}`,
    });
    const body = detail.json();
    expect(body.state).toBe("approved");
    // One decision row, of the ordinary kind — there is no chat-side approval
    // implementation for it to have come from.
    expect(body.decisions.at(-1)).toMatchObject({ action: "approve", toState: "approved" });
  });
});

describe("the command route", () => {
  it("/approve answers with cards without calling the model at all", async () => {
    // The scripted gateway has NO steps: if a model call happened, this throws.
    const { app, workspaceId } = await appWith([]);
    pendingDraft(workspaceId);
    const sessionId = await session(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/command`,
      payload: { command: "approve" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].kind).toBe("draft");
    expect(body.message.costCents).toBe(0);
    expect(body.userMessage.content).toBe("/approve");
  });

  it("refuses an instant command sent as a message, rather than paying for a turn", async () => {
    const { app, workspaceId } = await appWith([]);
    const sessionId = await session(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
      payload: { message: "/status", command: "status" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_a_directive_command");
  });

  it("rejects an unknown command", async () => {
    const { app, workspaceId } = await appWith([]);
    const sessionId = await session(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/command`,
      payload: { command: "rm_rf" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });
});

describe("the pin routes", () => {
  it("pins, lists, rebinds scope and unpins", async () => {
    const { app, workspaceId } = await appWith([]);
    const sessionId = await session(app, workspaceId);
    const campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Spring Launch", objective: "Land 50 RevOps demos" },
      })
    ).json().id as string;

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/pins`,
      payload: { kind: "campaign", refId: campaignId },
    });
    expect(created.statusCode).toBe(201);
    const pin = chatPinSchema.parse(created.json());
    expect(pin.label).toBe("Spring Launch");

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}`,
    });
    const parsed = chatSessionDetailSchema.parse(detail.json());
    expect(parsed.pins).toHaveLength(1);
    // D-77.5: the chip and the thread's scope are the same fact.
    expect(parsed.campaignId).toBe(campaignId);

    const removed = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/pins/${pin.id}`,
    });
    expect(removed.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/pins`,
    });
    expect(after.json() as ChatPin[]).toHaveLength(0);
  });

  it("refuses a pin to something this workspace cannot see", async () => {
    const { app, workspaceId } = await appWith([]);
    const sessionId = await session(app, workspaceId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/pins`,
      payload: { kind: "campaign", refId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("pin_target_not_found");
  });

  it("404s on unpinning something that is not there", async () => {
    const { app, workspaceId } = await appWith([]);
    const sessionId = await session(app, workspaceId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/chat/sessions/${sessionId}/pins/nope`,
    });
    expect(res.statusCode).toBe(404);
  });
});
