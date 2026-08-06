import { describe, expect, it, vi } from "vitest";
import { buildRendererApp, type BrowserRenderer } from "../src/app";

const request = {
  template: {
    html: "<main>{{title}}</main>",
    css: "main{color:#111}",
    placeholders: ["title"],
  },
  values: { title: "Launch" },
  width: 1080,
  height: 1080,
};

function fakeRenderer(): BrowserRenderer {
  return {
    render: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    close: vi.fn(async () => undefined),
  };
}

describe("renderer service", () => {
  it("keeps health public without allocating browser work", async () => {
    const renderer = fakeRenderer();
    const app = await buildRendererApp({ renderer, token: "secret" });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(renderer.render).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([undefined, "Bearer wrong", "Basic secret"])(
    "rejects an unauthenticated render request (%s)",
    async (authorization) => {
      const renderer = fakeRenderer();
      const app = await buildRendererApp({ renderer, token: "secret" });
      const response = await app.inject({
        method: "POST",
        url: "/render",
        headers: authorization ? { authorization } : {},
        payload: request,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "unauthorized",
        message: "A valid renderer token is required.",
      });
      expect(renderer.render).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("returns PNG bytes for one validated authenticated request", async () => {
    const renderer = fakeRenderer();
    const app = await buildRendererApp({ renderer, token: "secret" });
    const response = await app.inject({
      method: "POST",
      url: "/render",
      headers: { authorization: "Bearer secret" },
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(renderer.render).toHaveBeenCalledWith(request);
    await app.close();
    expect(renderer.close).toHaveBeenCalledOnce();
  });

  it("returns a bounded validation error without browser work", async () => {
    const renderer = fakeRenderer();
    const app = await buildRendererApp({ renderer, token: "secret" });
    const response = await app.inject({
      method: "POST",
      url: "/render",
      headers: { authorization: "Bearer secret" },
      payload: { ...request, width: 8 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_render_request" });
    expect(response.json().message.length).toBeLessThanOrEqual(500);
    expect(renderer.render).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a request that is large but valid under the shared contract", async () => {
    const renderer = fakeRenderer();
    const app = await buildRendererApp({ renderer, token: "secret" });
    const placeholders = Array.from({ length: 10 }, (_, index) => `value-${index}`);
    const response = await app.inject({
      method: "POST",
      url: "/render",
      headers: { authorization: "Bearer secret" },
      payload: {
        template: {
          html: "x".repeat(500_000),
          css: "x".repeat(500_000),
          placeholders,
        },
        values: Object.fromEntries(placeholders.map((name) => [name, "x".repeat(20_000)])),
        width: 1080,
        height: 1080,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(renderer.render).toHaveBeenCalledOnce();
    await app.close();
  });

  it("maps renderer timeouts without exposing internal errors", async () => {
    const renderer = fakeRenderer();
    vi.mocked(renderer.render).mockRejectedValue(new Error("render_timeout"));
    const app = await buildRendererApp({ renderer, token: "secret" });
    const response = await app.inject({
      method: "POST",
      url: "/render",
      headers: { authorization: "Bearer secret" },
      payload: request,
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      error: "render_timeout",
      message: "The render exceeded its time limit.",
    });
    await app.close();
  });
});
