import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createBrowserRenderer } from "../src/browser-renderer";

const request = {
  template: {
    html: "<main>{{title}}</main>",
    css: "main{background:#123}",
    placeholders: ["title"],
  },
  values: { title: "Tuezday" },
  width: 640,
  height: 400,
};

describe("browser renderer deadlines", () => {
  it("does not create a late context after browser launch exceeds the deadline", async () => {
    let resolveLaunch!: (browser: Browser) => void;
    const launchBrowser = vi.fn(
      () => new Promise<Browser>((resolve) => {
        resolveLaunch = resolve;
      }),
    );
    const newContext = vi.fn();
    const close = vi.fn(async () => undefined);
    const renderer = createBrowserRenderer({
      maxConcurrency: 1,
      timeoutMs: 5,
      launchBrowser,
    });

    const pending = renderer.render(request);
    await expect(pending).rejects.toThrow("render_timeout");
    resolveLaunch({ isConnected: () => true, newContext, close } as unknown as Browser);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(newContext).not.toHaveBeenCalled();
    await renderer.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

const chromiumAvailable = existsSync(chromium.executablePath());

describe.runIf(chromiumAvailable)("browser renderer smoke", () => {
  it("renders the requested PNG dimensions in its own browser owner", async () => {
    const renderer = createBrowserRenderer({ maxConcurrency: 1, timeoutMs: 15_000 });
    try {
      const png = await renderer.render({
        ...request,
        template: {
          ...request.template,
          html: '<main><h1>{{title}}</h1><img src="https://example.invalid/tracker.png"></main>',
          css: "main{width:100%;height:100%;background:#123}h1{color:#fff}",
        },
      });
      expect(png.byteLength).toBeGreaterThan(1_000);
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      expect(view.getUint32(16)).toBe(640);
      expect(view.getUint32(20)).toBe(400);
    } finally {
      await renderer.close();
    }
  }, 60_000);
});
