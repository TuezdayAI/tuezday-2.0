import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHAT_THREAD_TOKEN_CAP, type ChatSession } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { chatSessions } from "../src/db/schema";
import type { AddDocumentInput, EvidenceStore, StoreSearchResult } from "../src/evidence/store";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

// ---------------------------------------------------------------------------
// The chat routes (Sprint 76), including the platform's first SSE endpoint.
// The turn service has its own suite; what is asserted here is the transport:
// framing, content negotiation, the budget refusals, and tenant scoping.
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

const titleStep: ScriptedStep = { text: JSON.stringify({ title: "Thread", goal: "" }) };

let db: Db;

/** An authed app plus a workspace to talk to. */
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

async function newThread(
  app: App,
  workspaceId: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/workspaces/" + workspaceId + "/chat/sessions",
    payload,
  });
  return created.json<ChatSession>().id;
}

/** Parse an SSE payload into ordered `{type, data}` frames. */
function parseFrames(payload: string): { type: string; data: Record<string, unknown> }[] {
  return payload
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0 && !frame.startsWith(":"))
    .map((frame) => {
      const type = /^event: (.+)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "{}";
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("threads", () => {
  it("creates a thread with scope and returns it", async () => {
    const { app, workspaceId } = await appWith([]);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions",
      payload: { goal: "Launch the product", channel: "linkedin" },
    });

    expect(res.statusCode).toBe(201);
    const session = res.json<ChatSession>();
    expect(session.goal).toBe("Launch the product");
    expect(session.channel).toBe("linkedin");
    expect(session.totalInputTokens).toBe(0);
  });

  it("patches title, goal and scope, and unbinds scope with null", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId, { channel: "linkedin" });

    const patched = await app.inject({
      method: "PATCH",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id,
      payload: { title: "Renamed", goal: "New goal", channel: null },
    });

    expect(patched.statusCode).toBe(200);
    const session = patched.json<ChatSession>();
    expect(session.title).toBe("Renamed");
    expect(session.goal).toBe("New goal");
    expect(session.channel).toBeNull();
  });

  it("404s a thread belonging to another workspace", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId);

    const other = await registerUser(app, "other@example.com");
    const otherApp = asUser(app, other.token);
    const otherWorkspaceId = (
      await otherApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Rival" } })
    ).json().id as string;

    const res = await otherApp.inject({
      method: "GET",
      url: "/workspaces/" + otherWorkspaceId + "/chat/sessions/" + id,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("sending a message", () => {
  it("returns the finished turn as JSON when the client does not ask to stream", async () => {
    const { app, workspaceId } = await appWith([titleStep, { text: "Here is what I found." }]);
    const id = await newThread(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id + "/messages",
      payload: { message: "What is working?" },
    });

    expect(res.statusCode).toBe(201);
    const turn = res.json();
    expect(turn.answer).toBe("Here is what I found.");
    expect(turn.stopReason).toBe("complete");
    expect(turn.agentRunId).toBeTruthy();
    expect(turn.message.role).toBe("assistant");
    expect(turn.threadTokens).toBeGreaterThan(0);
  });

  it("streams SSE frames in order when the client asks for them", async () => {
    const { app, workspaceId } = await appWith([
      titleStep,
      { toolCalls: [{ name: "list_campaigns", arguments: {} }] },
      { text: "No campaigns yet." },
    ]);
    const id = await newThread(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id + "/messages",
      headers: { accept: "text/event-stream" },
      payload: { message: "Which campaigns?" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const frames = parseFrames(res.payload);
    const types = frames.map((f) => f.type);
    expect(types[0]).toBe("session");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");
    expect(types).toContain("text_delta");
    expect(types.at(-2)).toBe("message");
    expect(types.at(-1)).toBe("done");

    // The terminal frame carries what the client needs without a refetch.
    const done = frames.at(-1)!.data;
    expect(done.stopReason).toBe("complete");
    expect(done.threadTokens as number).toBeGreaterThan(0);
  });

  it("refuses once the thread's token cap is spent", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId);
    await db.update(chatSessions)
      .set({ totalInputTokens: CHAT_THREAD_TOKEN_CAP })
      .where(eq(chatSessions.id, id));

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id + "/messages",
      payload: { message: "One more" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("thread_budget_exhausted");
    // The refusal tells the founder what to do next.
    expect(res.json().message).toContain("Start a new one");
  });

  it("rejects an empty message before spending anything", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id + "/messages",
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s a message sent to a thread in another workspace", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId);
    const otherWorkspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Second" } })
    ).json().id as string;

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + otherWorkspaceId + "/chat/sessions/" + id + "/messages",
      payload: { message: "Leak me something" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the Sprint 42 confirm route is gone", () => {
  it("no longer exists", async () => {
    const { app, workspaceId } = await appWith([]);
    const id = await newThread(app, workspaceId);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/" + workspaceId + "/chat/sessions/" + id + "/confirm",
      payload: { confirmToken: "x", decision: "confirm" },
    });
    expect(res.statusCode).toBe(404);
  });
});
