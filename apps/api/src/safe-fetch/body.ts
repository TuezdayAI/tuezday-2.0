import type { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";
import { SafeFetchError, safeFetchError } from "./errors";
import {
  SAFE_FETCH_MIME_TYPES,
  type SafeFetchProfile,
} from "./policy";
import type { TransportBody } from "./transport";

const MIME_TOKEN =
  /^[a-z0-9!#$%&'*+\-.^_`|~]+\/[a-z0-9!#$%&'*+\-.^_`|~]+$/;
const SUPPORTED_ENCODINGS = new Set(["identity", "gzip", "deflate", "br"]);

export interface BoundedBodyLimits {
  maxCompressedBytes: number;
  maxDecodedBytes: number;
  maxExpansionRatio: number;
}

export interface ReadBoundedBodyOptions {
  body: TransportBody;
  contentType: string | undefined;
  contentEncoding?: string | undefined;
  profile: SafeFetchProfile;
  limits: BoundedBodyLimits;
  signal: AbortSignal;
}

export interface BoundedBodyResult {
  bytes: Uint8Array;
  contentType: string;
}

export function normalizeContentType(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime && MIME_TOKEN.test(mime) ? mime : undefined;
}

export function assertAllowedMime(
  profile: SafeFetchProfile,
  contentType: string | undefined,
): string {
  const mime = normalizeContentType(contentType);
  if (!mime) throw safeFetchError("mime_blocked");

  const fixed = SAFE_FETCH_MIME_TYPES[profile] as readonly string[];
  const allowed =
    fixed.includes(mime) ||
    (profile === "json" && mime.endsWith("+json"));
  if (!allowed) throw safeFetchError("mime_blocked");
  return mime;
}

function normalizeContentEncoding(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "identity";
  const parts = value.split(",").map((part) => part.trim().toLowerCase());
  if (
    parts.length !== 1 ||
    !parts[0] ||
    !SUPPORTED_ENCODINGS.has(parts[0])
  ) {
    throw safeFetchError("encoding_blocked");
  }
  return parts[0];
}

function decoderFor(encoding: string): Transform | undefined {
  switch (encoding) {
    case "identity":
      return undefined;
    case "gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw safeFetchError("encoding_blocked");
  }
}

function destroyBody(body: TransportBody): void {
  try {
    body.destroy();
  } catch {
    // Preserve the stable safe-fetch failure if upstream cleanup also fails.
  }
}

export async function readBoundedBody(
  options: ReadBoundedBodyOptions,
): Promise<BoundedBodyResult> {
  if (options.signal.aborted) {
    const error = safeFetchError("total_timeout");
    destroyBody(options.body);
    throw error;
  }

  let contentType: string;
  let encoding: string;
  try {
    contentType = assertAllowedMime(options.profile, options.contentType);
    encoding = normalizeContentEncoding(options.contentEncoding);
  } catch (cause) {
    destroyBody(options.body);
    throw cause;
  }

  let compressedBytes = 0;
  let decodedBytes = 0;
  const chunks: Uint8Array[] = [];

  const countedInput = async function* (
    source: AsyncIterable<unknown>,
  ): AsyncGenerator<Uint8Array> {
    for await (const rawChunk of source) {
      const chunk =
        rawChunk instanceof Uint8Array
          ? rawChunk
          : Buffer.from(rawChunk as ArrayBuffer);
      compressedBytes += chunk.byteLength;
      if (compressedBytes > options.limits.maxCompressedBytes) {
        throw safeFetchError("compressed_limit");
      }
      yield chunk;
    }
  };

  const decoder = decoderFor(encoding);
  const collect = async (source: AsyncIterable<unknown>): Promise<void> => {
    for await (const rawChunk of source) {
      const chunk =
        rawChunk instanceof Uint8Array
          ? rawChunk
          : Buffer.from(rawChunk as ArrayBuffer);
      decodedBytes += chunk.byteLength;
      if (decodedBytes > options.limits.maxDecodedBytes) {
        throw safeFetchError("decoded_limit");
      }
      if (
        decodedBytes >
        Math.max(1, compressedBytes) * options.limits.maxExpansionRatio
      ) {
        throw safeFetchError("decompression_ratio");
      }
      chunks.push(chunk);
    }
  };

  const consume = async (): Promise<BoundedBodyResult> => {
    if (decoder) {
      await pipeline(
        options.body,
        countedInput,
        decoder,
        collect,
        { signal: options.signal },
      );
    } else {
      await pipeline(
        options.body,
        countedInput,
        collect,
        { signal: options.signal },
      );
    }
    return {
      bytes: Buffer.concat(chunks),
      contentType,
    };
  };

  let rejectOnAbort: ((error: SafeFetchError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    const error = safeFetchError("total_timeout");
    destroyBody(options.body);
    decoder?.destroy();
    rejectOnAbort?.(error);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  try {
    return await Promise.race([consume(), aborted]);
  } catch (cause) {
    destroyBody(options.body);
    decoder?.destroy();
    if (options.signal.aborted) throw safeFetchError("total_timeout", cause);
    if (cause instanceof SafeFetchError) throw cause;
    throw safeFetchError("encoding_blocked", cause);
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}
