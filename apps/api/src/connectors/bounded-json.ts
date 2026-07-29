export type BoundedJsonErrorCode = "response_limit" | "response_aborted";

export class BoundedJsonError extends Error {
  constructor(public readonly code: BoundedJsonErrorCode) {
    super(
      code === "response_limit"
        ? "The connector response exceeded its byte limit."
        : "The connector response was cancelled.",
    );
    this.name = "BoundedJsonError";
  }
}

export interface BoundedJsonResult {
  json: unknown;
  decodedBytes: number;
}

function joinChunks(
  chunks: readonly Uint8Array[],
  decodedBytes: number,
): Uint8Array {
  const joined = new Uint8Array(decodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readBoundedJsonResponse(
  response: Response,
  options: {
    maxBytes: number;
    signal: AbortSignal;
  },
): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new BoundedJsonError("response_limit");
  }

  const body = response.body;
  if (!body) return { json: undefined, decodedBytes: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let decodedBytes = 0;
  let rejectOnAbort: ((error: BoundedJsonError) => void) | undefined;
  let cancellation: Promise<void> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    cancellation = reader.cancel(options.signal.reason).catch(() => undefined);
    rejectOnAbort?.(new BoundedJsonError("response_aborted"));
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  try {
    while (true) {
      const step = await Promise.race([reader.read(), aborted]);
      if (step.done) break;
      decodedBytes += step.value.byteLength;
      if (decodedBytes > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedJsonError("response_limit");
      }
      chunks.push(step.value);
    }
  } catch (cause) {
    if (cause instanceof BoundedJsonError) throw cause;
    if (options.signal.aborted) {
      throw new BoundedJsonError("response_aborted");
    }
    throw cause;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    await cancellation;
    reader.releaseLock();
  }

  const text = new TextDecoder().decode(joinChunks(chunks, decodedBytes));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { json, decodedBytes };
}
