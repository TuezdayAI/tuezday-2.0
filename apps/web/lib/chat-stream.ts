import { chatStreamEventSchema, type ChatStreamEvent } from "@tuezday/contracts";
import { createSseParser, readSseStream, type SseParser } from "./sse-stream";

// ---------------------------------------------------------------------------
// Chat's binding of the shared SSE reader (Sprint 76; the transport moved to
// `sse-stream.ts` in Sprint 79, when the agent-task progress stream became the
// second consumer). Everything chat-specific is the schema.
// ---------------------------------------------------------------------------

export function createChatStreamParser(): SseParser<ChatStreamEvent> {
  return createSseParser(chatStreamEventSchema);
}

export async function readChatStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  await readSseStream(response, chatStreamEventSchema, onEvent);
}
