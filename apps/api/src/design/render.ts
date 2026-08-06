import {
  renderErrorSchema,
  renderRequestSchema,
  type RenderErrorCode,
  type RenderRequest,
} from "@tuezday/contracts";

export type RenderInput = Omit<RenderRequest, "width" | "height"> &
  Partial<Pick<RenderRequest, "width" | "height">>;
export type Render = (input: RenderInput) => Promise<Uint8Array>;

const DEFAULT_RENDERER_URL = "http://127.0.0.1:7457";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class RendererError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RendererError";
  }
}

function rendererUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RendererError("renderer_unavailable", "The renderer URL is invalid.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RendererError(
      "renderer_unavailable",
      "The renderer URL must use HTTPS, except for loopback development.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

async function readBoundedPng(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new RendererError("invalid_renderer_response", "The renderer returned no PNG body.");
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PNG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RendererError(
          "invalid_renderer_response",
          "The renderer returned an oversized PNG.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength < PNG_SIGNATURE.byteLength) {
    throw new RendererError("invalid_renderer_response", "The renderer returned invalid PNG bytes.");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new RendererError("invalid_renderer_response", "The renderer returned invalid PNG bytes.");
  }
  return bytes;
}

export function createRendererClient(options?: {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Render {
  const baseUrl = rendererUrl(
    options?.baseUrl ?? process.env.TUEZDAY_RENDERER_URL?.trim() ?? DEFAULT_RENDERER_URL,
  );
  const token = options?.token ?? process.env.TUEZDAY_RENDERER_TOKEN?.trim() ?? "";
  const envTimeout = Number(process.env.TUEZDAY_RENDERER_TIMEOUT_MS);
  const timeoutMs =
    options?.timeoutMs ??
    (Number.isSafeInteger(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const fetcher = options?.fetcher ?? fetch;

  return async (input) => {
    if (!token) {
      throw new RendererError(
        "renderer_unavailable",
        "Image rendering is not configured. Set TUEZDAY_RENDERER_TOKEN on the API and renderer.",
      );
    }
    const parsed = renderRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RendererError(
        "invalid_render_request",
        parsed.error.issues.map((issue) => issue.message).join(" ").slice(0, 500),
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}/render`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = renderErrorSchema.safeParse(await response.json().catch(() => null));
        if (error.success) throw new RendererError(error.data.error, error.data.message);
        throw new RendererError(
          "renderer_unavailable",
          `The renderer returned HTTP ${response.status}.`,
        );
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "image/png") {
        throw new RendererError(
          "invalid_renderer_response",
          "The renderer returned a non-PNG response.",
        );
      }
      const advertisedHeader = response.headers.get("content-length");
      if (advertisedHeader !== null) {
        const advertisedLength = Number(advertisedHeader);
        if (
          !Number.isSafeInteger(advertisedLength) ||
          advertisedLength < PNG_SIGNATURE.byteLength ||
          advertisedLength > MAX_PNG_BYTES
        ) {
          throw new RendererError(
            "invalid_renderer_response",
            "The renderer returned an invalid PNG size.",
          );
        }
      }
      return await readBoundedPng(response);
    } catch (error) {
      if (error instanceof RendererError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new RendererError("render_timeout", "The render exceeded its time limit.");
      }
      throw new RendererError("renderer_unavailable", "The renderer service is unavailable.");
    } finally {
      clearTimeout(timer);
    }
  };
}
