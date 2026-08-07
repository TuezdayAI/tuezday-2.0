import { describe, expect, it } from "vitest";
import { createChatStreamParser, readChatStream } from "./chat-stream";

// ---------------------------------------------------------------------------
// SSE parsing (Sprint 76). The property that matters: network chunks and SSE
// frames have nothing to do with each other, so a frame split across three
// reads must still arrive exactly once, intact.
// ---------------------------------------------------------------------------

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

describe("createChatStreamParser", () => {
  it("parses one whole frame", () => {
    const parser = createChatStreamParser();
    const events = parser.push(frame("text_delta", { stepIndex: 0, text: "hi" }));
    expect(events).toEqual([{ type: "text_delta", stepIndex: 0, text: "hi" }]);
  });

  it("parses several frames arriving in one chunk", () => {
    const parser = createChatStreamParser();
    const events = parser.push(
      frame("step_start", { stepIndex: 0 }) + frame("text_delta", { stepIndex: 0, text: "a" }),
    );
    expect(events.map((e) => e.type)).toEqual(["step_start", "text_delta"]);
  });

  it("reassembles a frame split across chunks", () => {
    const parser = createChatStreamParser();
    const whole = frame("text_delta", { stepIndex: 0, text: "hello world" });
    const a = whole.slice(0, 12);
    const b = whole.slice(12, 30);
    const c = whole.slice(30);

    expect(parser.push(a)).toEqual([]);
    expect(parser.push(b)).toEqual([]);
    expect(parser.push(c)).toEqual([{ type: "text_delta", stepIndex: 0, text: "hello world" }]);
  });

  it("splits a chunk that ends mid-frame without losing the tail", () => {
    const parser = createChatStreamParser();
    const first = frame("step_start", { stepIndex: 0 });
    const second = frame("text_delta", { stepIndex: 0, text: "x" });

    const events = parser.push(first + second.slice(0, 10));
    expect(events.map((e) => e.type)).toEqual(["step_start"]);
    expect(parser.push(second.slice(10)).map((e) => e.type)).toEqual(["text_delta"]);
  });

  it("ignores heartbeat comments", () => {
    const parser = createChatStreamParser();
    const events = parser.push(":\n\n" + frame("step_start", { stepIndex: 1 }) + ":\n\n");
    expect(events).toEqual([{ type: "step_start", stepIndex: 1 }]);
  });

  it("drops a malformed frame rather than throwing", () => {
    const parser = createChatStreamParser();
    const events = parser.push(
      "event: text_delta\ndata: {not json\n\n" + frame("step_start", { stepIndex: 0 }),
    );
    // The bad frame is skipped; the good one still arrives.
    expect(events).toEqual([{ type: "step_start", stepIndex: 0 }]);
  });

  it("drops a frame whose payload does not match the contract", () => {
    const parser = createChatStreamParser();
    expect(parser.push('event: text_delta\ndata: {"type":"text_delta"}\n\n')).toEqual([]);
    expect(parser.push('event: nope\ndata: {"type":"nope"}\n\n')).toEqual([]);
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const parser = createChatStreamParser();
    expect(parser.push('event: done\ndata: {"type":"done","stopReason":"complete","costCents":0,"threadTokens":1,"threadCostCents":0}')).toEqual([]);
    expect(parser.flush().map((e) => e.type)).toEqual(["done"]);
  });

  it("handles CRLF line endings", () => {
    const parser = createChatStreamParser();
    const events = parser.push(
      'event: step_start\r\ndata: {"type":"step_start","stepIndex":2}\r\n\r\n',
    );
    expect(events).toEqual([{ type: "step_start", stepIndex: 2 }]);
  });
});

describe("readChatStream", () => {
  function responseFrom(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body);
  }

  it("delivers every frame in order", async () => {
    const seen: string[] = [];
    await readChatStream(
      responseFrom([
        frame("session", { sessionId: "s", userMessageId: "m" }),
        frame("text_delta", { stepIndex: 0, text: "hi" }),
        frame("done", {
          stopReason: "complete",
          costCents: 0.1,
          threadTokens: 5,
          threadCostCents: 0.1,
        }),
      ]),
      (event) => seen.push(event.type),
    );
    expect(seen).toEqual(["session", "text_delta", "done"]);
  });

  it("reassembles across the chunk boundaries the network chose", async () => {
    const whole =
      frame("session", { sessionId: "s", userMessageId: "m" }) +
      frame("text_delta", { stepIndex: 0, text: "streamed" });
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7));

    const seen: string[] = [];
    await readChatStream(responseFrom(chunks), (e) => seen.push(e.type));
    expect(seen).toEqual(["session", "text_delta"]);
  });

  it("resolves immediately on a body-less response rather than hanging", async () => {
    const seen: string[] = [];
    await readChatStream(new Response(null), (e) => seen.push(e.type));
    expect(seen).toEqual([]);
  });
});
