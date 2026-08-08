
// ---------------------------------------------------------------------------
// SSE frame parsing (Sprint 76, generalized Sprint 79).
//
// `EventSource` is not usable here: it cannot carry the bearer token the auth
// guard requires. So the client reads `Response.body` directly and this module
// turns the byte stream into typed events.
//
// The one thing it must get right is that network chunks and SSE frames have
// nothing to do with each other: a frame can arrive split across three chunks,
// and three frames can arrive in one. Hence the retained buffer.
//
// Sprint 79 made it schema-agnostic. Chat's stream and the agent-task progress
// stream are the same transport carrying different vocabularies, and there was
// no reason for the second one to re-derive the buffering.
// ---------------------------------------------------------------------------

const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Just enough of a zod schema to decode a frame. Declared structurally rather
 * than as `ZodType<E>`: zod's generic is invariant in its INPUT type, so a
 * schema with any defaulted field will not unify with `ZodType<Output>` and
 * every caller would need a cast. All this module needs is `safeParse`.
 */
export interface EventDecoder<E> {
  safeParse: (data: unknown) => { success: true; data: E } | { success: false; error: unknown };
}

export interface SseParser<E> {
  push: (chunk: string) => E[];
  flush: () => E[];
}

/**
 * Incremental parser. Feed it decoded text; it returns whichever complete
 * frames that text finished, retaining any partial frame for the next call.
 *
 * Unparseable frames are dropped rather than thrown: a stream is a live UI, and
 * one malformed frame must not take down a conversation mid-answer.
 */
export function createSseParser<E>(schema: EventDecoder<E>): SseParser<E> {
  let buffer = "";

  const parseFrame = (frame: string): E | null => {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      // Comments (heartbeats) and the redundant `event:` name — the payload
      // carries its own discriminant, so the field name is not load-bearing.
      if (line.startsWith(":") || line.startsWith("event:")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(dataLines.join("\n")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const drain = (text: string, keepTail: boolean): E[] => {
    buffer += text;
    const parts = buffer.split(FRAME_SEPARATOR);
    buffer = keepTail ? (parts.pop() ?? "") : "";
    const events: E[] = [];
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
export async function readSseStream<E>(
  response: Response,
  schema: EventDecoder<E>,
  onEvent: (event: E) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(schema);

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
