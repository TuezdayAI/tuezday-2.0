import { chromium, type Browser } from "playwright";
import type { RenderRequest } from "@tuezday/contracts";
import { substituteTemplate } from "./template";

export interface BrowserRenderer {
  render(input: RenderRequest): Promise<Uint8Array>;
  close(): Promise<void>;
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async enter(): Promise<() => void> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

async function withinDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("render_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createBrowserRenderer(options: {
  maxConcurrency: number;
  timeoutMs: number;
  launchBrowser?: () => Promise<Browser>;
}): BrowserRenderer {
  const gate = new ConcurrencyGate(options.maxConcurrency);
  const launchBrowser = options.launchBrowser ?? (() => chromium.launch());
  let browserPromise: Promise<Browser> | null = null;

  async function browser(): Promise<Browser> {
    const current = browserPromise ? await browserPromise.catch(() => null) : null;
    if (current?.isConnected()) return current;
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = null;
      throw error;
    });
    return browserPromise;
  }

  return {
    async render(input) {
      const document = substituteTemplate(input);
      const release = await gate.enter();
      let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
      let timedOut = false;
      try {
        return await withinDeadline(
          (async () => {
            const activeBrowser = await browser();
            if (timedOut) throw new Error("render_timeout");
            const nextContext = await activeBrowser.newContext({
              javaScriptEnabled: false,
              viewport: { width: input.width, height: input.height },
            });
            if (timedOut) {
              await nextContext.close().catch(() => undefined);
              throw new Error("render_timeout");
            }
            context = nextContext;
            await context.route("**/*", (route) => route.abort("blockedbyclient"));
            const page = await context.newPage();
            page.setDefaultTimeout(options.timeoutMs);
            await page.setContent(document, { waitUntil: "load", timeout: options.timeoutMs });
            return await page.screenshot({ type: "png", timeout: options.timeoutMs });
          })(),
          options.timeoutMs,
          () => {
            timedOut = true;
            void context?.close().catch(() => undefined);
          },
        );
      } finally {
        await context?.close().catch(() => undefined);
        release();
      }
    },

    async close() {
      const activeBrowser = browserPromise ? await browserPromise.catch(() => null) : null;
      browserPromise = null;
      await activeBrowser?.close().catch(() => undefined);
    },
  };
}
