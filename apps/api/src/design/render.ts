import type { Browser } from "playwright";

// Deterministic template -> PNG renderer (Sprint 41 Part 3). This is the hot
// path: placeholder substitution + a headless-chromium screenshot. No LLM, no
// Open Design, no network beyond the local browser — the whole cost model
// (umbrella Decision 3) rests on this staying pure.

export interface RenderTemplate {
  html: string;
  css: string;
  placeholders: string[];
}

export interface RenderInput {
  template: RenderTemplate;
  values: Record<string, string>;
  width?: number;
  height?: number;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Substitute values into {{placeholder}} tokens. Every declared placeholder
 * must have a value — a missing one throws rather than rendering half-filled
 * art. Values are HTML-escaped; extra values are ignored.
 */
export function substituteTemplate(template: RenderTemplate, values: Record<string, string>): string {
  const missing = template.placeholders.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing placeholder value(s): ${missing.join(", ")}`);
  }
  const html = template.html.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (token, name: string) =>
    values[name] === undefined ? token : escapeHtml(values[name]),
  );
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><style>",
    "html,body{margin:0;padding:0;}",
    template.css,
    "</style></head><body>",
    html,
    "</body></html>",
  ].join("\n");
}

// One lazily-launched browser per process; pages per render; closed on app
// shutdown via closeRenderer(). Import of playwright is deferred so processes
// that never render (tests, worker) don't pay the startup cost.
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch());
  }
  return browserPromise;
}

export async function closeRenderer(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close().catch(() => undefined);
  }
}

/** Render one slide to PNG bytes at the target dimensions (1080x1080 default). */
export async function renderSlide({ template, values, width = 1080, height = 1080 }: RenderInput): Promise<Uint8Array> {
  const content = substituteTemplate(template, values); // throws before any browser work
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent(content, { waitUntil: "networkidle" });
    return await page.screenshot({ type: "png" });
  } finally {
    await page.close().catch(() => undefined);
  }
}
