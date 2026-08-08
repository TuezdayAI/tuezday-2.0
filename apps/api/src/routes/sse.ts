import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Server-sent events, shared by the two endpoints that stream (Sprint 79).
 *
 * Extracted from `routes/chat.ts`, which had the platform's first SSE endpoint
 * (Sprint 76) and owned this inline. Nothing about the mechanism was
 * chat-specific: hijack the reply, write frames as they happen, keep an idle
 * connection alive through a long gap.
 */

/** Keeps an idle stream alive through a long tool call. */
export const SSE_HEARTBEAT_MS = 15_000;

export function wantsStream(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "").includes("text/event-stream");
}

export interface SseStream<E extends { type: string }> {
  send: (event: E) => void;
  /** True once the client hung up, so a poll loop can stop doing work nobody
   * will read rather than running to its own deadline. */
  closed: () => boolean;
  close: () => void;
}

/**
 * Hijack the reply and return a writer. Fastify is told to stand aside so
 * frames can be written as they happen; the route stays a thin adapter over
 * whatever service produces the events, and that service takes the same
 * callback whether or not anyone is streaming (D-76.10).
 */
export function openStream<E extends { type: string }>(reply: FastifyReply): SseStream<E> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer defeat the entire point of streaming.
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(":\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  let clientGone = false;
  reply.raw.on("close", () => {
    clientGone = true;
  });

  return {
    send(event) {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    closed() {
      return clientGone || reply.raw.writableEnded;
    },
    close() {
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}
