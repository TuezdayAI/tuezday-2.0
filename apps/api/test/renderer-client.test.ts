import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createRendererClient, RendererError, type RenderInput } from "../src/design/render";

const input: RenderInput = {
  template: {
    html: "<main>{{title}}</main>",
    css: "main{color:#111}",
    placeholders: ["title"],
  },
  values: { title: "Launch" },
  width: 1080,
  height: 1080,
};

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("renderer HTTP client", () => {
  it("keeps Playwright ownership out of the API workspace", () => {
    const apiPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const clientSource = readFileSync(new URL("../src/design/render.ts", import.meta.url), "utf8");
    expect(apiPackage.dependencies?.playwright).toBeUndefined();
    expect(appSource).not.toContain("closeRenderer");
    expect(clientSource).not.toContain('from "playwright"');
  });

  it("sends one authenticated bounded request and returns PNG bytes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(pngSignature, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "8" },
      }),
    );
    const render = createRendererClient({
      baseUrl: "http://127.0.0.1:7457/",
      token: "secret",
      timeoutMs: 1_000,
      fetcher,
    });

    await expect(render(input)).resolves.toEqual(pngSignature);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7457/render");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails locally when the renderer token is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const render = createRendererClient({ token: "", fetcher });
    await expect(render(input)).rejects.toMatchObject({
      name: "RendererError",
      code: "renderer_unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps a renderer error response without leaking arbitrary body text", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "render_timeout", message: "The render exceeded its time limit." }),
        { status: 504, headers: { "Content-Type": "application/json" } },
      ),
    );
    const render = createRendererClient({ token: "secret", fetcher });
    await expect(render(input)).rejects.toEqual(
      new RendererError("render_timeout", "The render exceeded its time limit."),
    );
  });

  it("rejects a non-PNG success response", async () => {
    const fetcher = vi.fn(async () =>
      new Response("not an image", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const render = createRendererClient({ token: "secret", fetcher });
    await expect(render(input)).rejects.toMatchObject({ code: "invalid_renderer_response" });
  });

  it("rejects an oversized response before reading it", async () => {
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "30000000" },
      }),
    );
    const render = createRendererClient({ token: "secret", fetcher });
    await expect(render(input)).rejects.toMatchObject({ code: "invalid_renderer_response" });
  });

  it("bounds streamed responses without relying on Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const render = createRendererClient({
      token: "secret",
      fetcher: vi.fn(async () =>
        new Response(body, { status: 200, headers: { "Content-Type": "image/png" } }),
      ),
    });

    await expect(render(input)).rejects.toMatchObject({ code: "invalid_renderer_response" });
    expect(cancelled).toBe(true);
  });

  it("rejects bytes that claim to be a PNG but lack its signature", async () => {
    const render = createRendererClient({
      token: "secret",
      fetcher: vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      ),
    });
    await expect(render(input)).rejects.toMatchObject({ code: "invalid_renderer_response" });
  });

  it("keeps the deadline active while reading the response body", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    const render = createRendererClient({ token: "secret", timeoutMs: 5, fetcher });

    await expect(render(input)).rejects.toMatchObject({ code: "render_timeout" });
  });

  it("maps transport and timeout failures to stable availability errors", async () => {
    const unavailable = createRendererClient({
      token: "secret",
      fetcher: vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1");
      }),
    });
    await expect(unavailable(input)).rejects.toMatchObject({ code: "renderer_unavailable" });

    const timeout = createRendererClient({
      token: "secret",
      timeoutMs: 5,
      fetcher: vi.fn((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ),
    });
    await expect(timeout(input)).rejects.toMatchObject({ code: "render_timeout" });
  });
});
