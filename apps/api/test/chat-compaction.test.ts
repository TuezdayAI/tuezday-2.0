import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_COMPACTION_KEEP_RECENT, type ChatMessage } from "@tuezday/contracts";
import { agentRuns, workspaces } from "../src/db/schema";
import type { Db } from "../src/db";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { ScriptedGateway } from "../src/llm/scripted";
import {
  appendMessage,
  createSession,
  getSessionRow,
  listActiveMessages,
  listMessages,
} from "../src/services/chat";
import { maybeCompact, shouldCompact } from "../src/services/chat-compaction";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Compaction (Sprint 76, D-76.11). The invariant under test throughout: a
// folded conversation is SUMMARIZED and MARKED, never silently dropped.
// ---------------------------------------------------------------------------

let db: Db;
let workspaceId: string;

/** Long enough that a handful of these blow the 60%-of-32k threshold. */
const LONG = "x ".repeat(3_000);

async function seedTranscript(sessionId: string, count: number, body = LONG): Promise<ChatMessage[]> {
  for (let i = 0; i < count; i++) {
    await appendMessage(db, workspaceId, sessionId, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${body} message ${i}`,
    });
  }
  return await listMessages(db, sessionId);
}

function summaryStep(summary: string, pinned: string[] = [], open: string[] = []) {
  return { text: JSON.stringify({ summary, pinnedEntities: pinned, openQuestions: open }) };
}

beforeEach(async () => {
  db = await createTestDb();
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "Acme", createdAt: 1, updatedAt: 1 });
});

describe("the threshold", () => {
  it("does not fire on a short conversation", async () => {
    const session = await createSession(db, workspaceId, null, {});
    expect(shouldCompact(await seedTranscript(session.id, 4))).toBe(false);
  });

  it("does not fire when everything would be kept verbatim anyway", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, CHAT_COMPACTION_KEEP_RECENT);
    expect(shouldCompact(messages)).toBe(false);
  });

  it("fires once the transcript outgrows the per-turn budget", async () => {
    const session = await createSession(db, workspaceId, null, {});
    expect(shouldCompact(await seedTranscript(session.id, 20))).toBe(true);
  });
});

describe("folding", () => {
  it("summarizes the older turns and keeps the newest verbatim", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);
    const llm = new ScriptedGateway([
      summaryStep("They want a launch campaign.", ["Launch campaign"], ["Which channels?"]),
    ]);

    const result = await maybeCompact(db, llm, session, messages);

    expect(result).not.toBeNull();
    expect(result!.message.role).toBe("compaction");
    expect(result!.message.content).toContain("They want a launch campaign.");
    expect(result!.message.content).toContain("Launch campaign");
    expect(result!.message.content).toContain("Which channels?");
    // The cutoff is the last message NOT kept verbatim.
    expect(result!.summarizedThrough).toBe(
      messages[messages.length - CHAT_COMPACTION_KEEP_RECENT - 1]!.id,
    );
  });

  it("records the compaction as its own agent_run", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);
    const llm = new ScriptedGateway([summaryStep("Summary.")]);

    const result = await maybeCompact(db, llm, session, messages);

    expect(result!.agentRunId).toBeTruthy();
    const run = (await db.select().from(agentRuns)).find((r) => r.id === result!.agentRunId);
    expect(run?.task).toBe("chat:compaction");
    expect(result!.usage.inputTokens).toBeGreaterThan(0);
  });

  it("nothing is deleted — the folded messages stay in the table", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);

    await maybeCompact(db, new ScriptedGateway([summaryStep("Summary.")]), session, messages);

    // 20 originals plus the compaction row.
    expect(await listMessages(db, session.id)).toHaveLength(21);
  });

  it("the next turn replays the summary plus the kept tail, not the whole history", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);

    const result = await maybeCompact(
      db,
      new ScriptedGateway([summaryStep("Established: they want a launch.")]),
      session,
      messages,
    );

    const row = await getSessionRow(db, workspaceId, session.id);
    expect(row?.compactedThroughMessageId).toBe(result!.summarizedThrough);

    const active = await listActiveMessages(db, session.id, row!.compactedThroughMessageId);
    expect(active).toHaveLength(CHAT_COMPACTION_KEEP_RECENT + 1);
    expect(active[0]!.role).toBe("compaction");
    expect(active[0]!.content).toContain("Established: they want a launch.");
    // The oldest original is gone from the replay but still on record.
    expect(active.some((m) => m.id === messages[0]!.id)).toBe(false);
  });
});

describe("failure never loses a turn", () => {
  it("degrades to an explicit truncation marker when the model is unavailable", async () => {
    const failing: LlmGateway = {
      async generate() {
        throw new GatewayError("provider_error", "down");
      },
      async agentStep() {
        throw new GatewayError("provider_error", "down");
      },
    };
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);

    const result = await maybeCompact(db, failing, session, messages);

    expect(result).not.toBeNull();
    expect(result!.message.role).toBe("compaction");
    // It says so, rather than pretending the earlier turns were summarized.
    expect(result!.message.content).toContain("could not be summarized");
    expect(result!.message.content).toContain("earlier messages were dropped");
    // And the marker is still set, so the thread stays sendable.
    expect((await getSessionRow(db, workspaceId, session.id))?.compactedThroughMessageId).toBe(
      result!.summarizedThrough,
    );
  });

  it("degrades the same way when the model returns an unusable summary", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 20);
    const llm = new ScriptedGateway([summaryStep("   ")]);

    const result = await maybeCompact(db, llm, session, messages);

    expect(result!.message.content).toContain("could not be summarized");
  });
});

describe("a stale marker degrades safely", () => {
  it("replays the whole transcript when the cutoff message is gone", async () => {
    const session = await createSession(db, workspaceId, null, {});
    const messages = await seedTranscript(session.id, 6);
    const active = await listActiveMessages(db, session.id, "a-message-that-no-longer-exists");
    expect(active).toHaveLength(messages.length);
  });
});
