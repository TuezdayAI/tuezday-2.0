import { chatStreamEventSchema, type ChatStreamEvent } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// SSE frame parsing (Sprint 76).
//
// `EventSource` is not usable here: it cannot carry the bearer token the auth
// guard requires. So the drawer reads `Response.body` directly and this module
// turns the byte stream into typed events.
//
// The one thing it must get right is that network chunks and SSE frames have
// nothing to do with each other: a frame can arrive split across three chunks,
// and three frames can arrive in one. Hence the retained buffer.
// ---------------------------------------------------------------------------

const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Incremental parser. Feed it decoded text; it returns whichever complete
 * frames that text finished, retaining any partial frame for the next call.
 *
 * Unparseable frames are dropped rather than thrown: a stream is a live UI, and
 * one malformed frame must not take down a conversation mid-answer.
 */
export function createChatStreamParser(): {
  push: (chunk: string) => ChatStreamEvent[];
  flush: () => ChatStreamEvent[];
} {
  let buffer = "";

  const parseFrame = (frame: string): ChatStreamEvent | null => {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      // Comments (heartbeats) and the redundant `event:` name — the payload
      // carries its own discriminant, so the field name is not load-bearing.
      if (line.startsWith(":") || line.startsWith("event:")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    try {
      const parsed = chatStreamEventSchema.safeParse(JSON.parse(dataLines.join("\n")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const drain = (text: string, keepTail: boolean): ChatStreamEvent[] => {
    buffer += text;
    const parts = buffer.split(FRAME_SEPARATOR);
    buffer = keepTail ? (parts.pop() ?? "") : "";
    const events: ChatStreamEvent[] = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      const event = parseFrame(part);
      if (event) events.push(event);
    }
    return events;
  };

  return {
    push: (chunk) => drain(chunk, true),
    // A stream that ends without a trailing blank line still has one real
    // frame left in the buffer.
    flush: () => drain("", false),
  };
}

/**
 * Read an SSE response to completion, invoking `onEvent` per frame. Resolves
 * when the stream closes. A body-less response resolves immediately rather
 * than hanging.
 */
export async function readChatStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createChatStreamParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    for (const event of parser.flush()) onEvent(event);
  } finally {
    reader.releaseLock();
  }
}
