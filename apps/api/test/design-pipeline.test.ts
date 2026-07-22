import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { createWorkspace } from "../src/services/workspaces";
import { ensureDefaultDesignSystem } from "../src/services/design-systems";
import {
  DesignProviderError,
  extractPlaceholders,
  type AuthorTemplateInput,
  type DesignProvider,
} from "../src/design/provider";
import { OpenDesignProvider } from "../src/design/open-design";
import { S3AssetStorage, StorageError } from "../src/design/storage";
import { escapeHtml, renderSlide, substituteTemplate } from "../src/design/render";
import { designSystemFingerprint, getOrAuthorTemplate } from "../src/design/templates";

type Fetcher = typeof fetch;

const TEMPLATE_HTML = `<div class="slide"><h1>{{title}}</h1><p>{{body}}</p><span>{{page}}</span></div>`;
const TEMPLATE_CSS = `.slide{width:100%;height:100%;background:#fff;} h1{font-size:96px;}`;

function fakeProvider(): DesignProvider & { calls: AuthorTemplateInput[] } {
  const calls: AuthorTemplateInput[] = [];
  return {
    calls,
    async authorTemplate(input) {
      calls.push(input);
      return { html: TEMPLATE_HTML, css: TEMPLATE_CSS, placeholders: ["title", "body", "page"] };
    },
  };
}

describe("design pipeline (Sprint 41 Part 3)", () => {
  let db: Db;
  let workspaceId: string;
  let designSystemId: string;

  beforeEach(() => {
    db = createDb(":memory:");
    workspaceId = createWorkspace(db, { name: "Design Co" }).id;
    designSystemId = ensureDefaultDesignSystem(db, workspaceId).id;
  });

  describe("getOrAuthorTemplate cache", () => {
    const lookup = (markdown: string) => ({
      workspaceId,
      designSystemId,
      skillId: "social-carousel",
      slideShape: "hook",
      resolvedDesignMarkdown: markdown,
      brief: "a 1080x1080 hook slide template",
    });

    it("authors on a miss, then serves every repeat from cache with zero provider calls", async () => {
      const provider = fakeProvider();
      const first = await getOrAuthorTemplate(db, provider, lookup("# Brand v1"));
      expect(provider.calls).toHaveLength(1);
      expect(first.designSystemFingerprint).toBe(designSystemFingerprint("# Brand v1"));
      expect(JSON.parse(first.placeholders)).toEqual(["title", "body", "page"]);

      const second = await getOrAuthorTemplate(db, provider, lookup("# Brand v1"));
      expect(provider.calls).toHaveLength(1); // the core cost guarantee
      expect(second.id).toBe(first.id);
    });

    it("re-authors when the resolved design markdown changes (fingerprint change)", async () => {
      const provider = fakeProvider();
      const v1 = await getOrAuthorTemplate(db, provider, lookup("# Brand v1"));
      const v2 = await getOrAuthorTemplate(db, provider, lookup("# Brand v2 — new palette"));
      expect(provider.calls).toHaveLength(2);
      expect(v2.id).not.toBe(v1.id);
      expect(v2.designSystemFingerprint).not.toBe(v1.designSystemFingerprint);
    });

    it("caches per slide shape — a new shape authors again, same shape does not", async () => {
      const provider = fakeProvider();
      await getOrAuthorTemplate(db, provider, lookup("# Brand"));
      await getOrAuthorTemplate(db, provider, { ...lookup("# Brand"), slideShape: "cta" });
      await getOrAuthorTemplate(db, provider, { ...lookup("# Brand"), slideShape: "cta" });
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls.map((c) => c.slideShape)).toEqual(["hook", "cta"]);
    });
  });

  describe("OpenDesignProvider", () => {
    function daemonFetcher(overrides?: {
      chatStatus?: number;
      htmlBody?: string;
      reject?: boolean;
    }): { fetcher: Fetcher; requests: Array<{ url: string; init: RequestInit }> } {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const fetcher: Fetcher = (async (url: any, init: any) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (overrides?.reject) throw new Error("ECONNREFUSED");
        const path = new URL(String(url)).pathname;
        if (path === "/api/projects") {
          return new Response(JSON.stringify({ id: "proj-1" }), { status: 200 });
        }
        if (path === "/api/chat") {
          return new Response(JSON.stringify({ ok: true }), { status: overrides?.chatStatus ?? 200 });
        }
        if (path.endsWith("template.html")) {
          return new Response(overrides?.htmlBody ?? TEMPLATE_HTML, { status: 200 });
        }
        if (path.endsWith("template.css")) {
          return new Response(TEMPLATE_CSS, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as Fetcher;
      return { fetcher, requests };
    }

    const input: AuthorTemplateInput = {
      skillId: "social-carousel",
      designSystemMarkdown: "# Brand",
      slideShape: "hook",
      brief: "a hook slide",
    };

    it("runs project-create -> chat -> file reads with auth header and orchestrator tag", async () => {
      const { fetcher, requests } = daemonFetcher();
      const provider = new OpenDesignProvider("http://od.internal", "od-token", fetcher, {
        protocol: "google",
        apiKey: "g-key",
      });
      const template = await provider.authorTemplate(input);

      expect(template.html).toBe(TEMPLATE_HTML);
      expect(template.css).toBe(TEMPLATE_CSS);
      expect(template.placeholders).toEqual(["title", "body", "page"]);

      expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
        "/api/projects",
        "/api/chat",
        "/api/projects/proj-1/files/template.html",
        "/api/projects/proj-1/files/template.css",
      ]);
      for (const r of requests) {
        expect((r.init.headers as Record<string, string>).Authorization).toBe("Bearer od-token");
      }
      const projectBody = JSON.parse(String(requests[0]!.init.body));
      expect(projectBody.orchestratorWorkspace).toEqual({
        kind: "scratch",
        sourceLabel: "tuezday:design-template",
        writeback: "external",
      });
      const chatBody = JSON.parse(String(requests[1]!.init.body));
      expect(chatBody.agentId).toBe("byok-opencode");
      expect(chatBody.skillId).toBe("social-carousel");
      expect(chatBody.byokProvider).toEqual({ protocol: "google", apiKey: "g-key" });
      expect(chatBody.message).toContain("# Brand");
    });

    it("wraps daemon errors and unreachability in DesignProviderError", async () => {
      const down = new OpenDesignProvider("http://od.internal", "t", daemonFetcher({ reject: true }).fetcher);
      await expect(down.authorTemplate(input)).rejects.toBeInstanceOf(DesignProviderError);

      const failing = new OpenDesignProvider(
        "http://od.internal",
        "t",
        daemonFetcher({ chatStatus: 500 }).fetcher,
      );
      await expect(failing.authorTemplate(input)).rejects.toBeInstanceOf(DesignProviderError);
    });

    it("refuses to cache a template without placeholder tokens", async () => {
      const provider = new OpenDesignProvider(
        "http://od.internal",
        "t",
        daemonFetcher({ htmlBody: "<div>static, no tokens</div>" }).fetcher,
      );
      await expect(provider.authorTemplate(input)).rejects.toThrow(/no \{\{placeholder\}\}/);
    });

    it("extractPlaceholders dedupes and keeps order", () => {
      expect(extractPlaceholders("{{a}} {{ b }} {{a}} {{c.d-e}}")).toEqual(["a", "b", "c.d-e"]);
    });
  });

  describe("S3AssetStorage", () => {
    const options = {
      endpoint: "https://storage.example.com",
      bucket: "tuezday-assets",
      accessKey: "AK",
      secretKey: "SK",
      publicBaseUrl: "https://cdn.tuezday.com",
    };

    it("PUTs a content-addressed key with a SigV4 authorization and returns the public URL", async () => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const fetcher: Fetcher = (async (url: any, init: any) => {
        requests.push({ url: String(url), init });
        return new Response("", { status: 200 });
      }) as Fetcher;
      const storage = new S3AssetStorage(options, fetcher, () => new Date("2026-07-09T00:00:00Z"));

      const bytes = new TextEncoder().encode("fake-png-bytes");
      const { url } = await storage.put(bytes, "image/png");

      expect(url).toMatch(/^https:\/\/cdn\.tuezday\.com\/design\/[0-9a-f]{64}\.png$/);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(
        /^https:\/\/storage\.example\.com\/tuezday-assets\/design\/[0-9a-f]{64}\.png$/,
      );
      const headers = requests[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AK\/20260709\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
      );
      expect(headers["x-amz-date"]).toBe("20260709T000000Z");
      expect(headers["Content-Type"]).toBe("image/png");
    });

    it("identical bytes produce the identical key (dedupe)", async () => {
      const urls: string[] = [];
      const fetcher: Fetcher = (async (url: any) => {
        urls.push(String(url));
        return new Response("", { status: 200 });
      }) as Fetcher;
      const storage = new S3AssetStorage(options, fetcher);
      const bytes = new TextEncoder().encode("same");
      const a = await storage.put(bytes, "image/png");
      const b = await storage.put(bytes, "image/png");
      expect(a.url).toBe(b.url);
      expect(urls[0]).toBe(urls[1]);
    });

    it("throws StorageError on non-2xx, unreachability, and missing config", async () => {
      const failing = new S3AssetStorage(options, (async () => new Response("denied", { status: 403 })) as Fetcher);
      await expect(failing.put(new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(StorageError);

      const down = new S3AssetStorage(options, (async () => {
        throw new Error("ECONNREFUSED");
      }) as Fetcher);
      await expect(down.put(new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(StorageError);

      const unconfigured = new S3AssetStorage({ endpoint: "", bucket: "", accessKey: "", secretKey: "", publicBaseUrl: "" });
      await expect(unconfigured.put(new Uint8Array([1]), "image/png")).rejects.toThrow(/not configured/);
    });
  });

  describe("renderer — pure substitution", () => {
    const template = { html: TEMPLATE_HTML, css: TEMPLATE_CSS, placeholders: ["title", "body", "page"] };

    it("substitutes and HTML-escapes values", () => {
      const doc = substituteTemplate(template, {
        title: "Ship <fast> & safe",
        body: 'Quote: "yes"',
        page: "2/8",
      });
      expect(doc).toContain("Ship &lt;fast&gt; &amp; safe");
      expect(doc).toContain("Quote: &quot;yes&quot;");
      expect(doc).toContain("2/8");
      expect(doc).not.toContain("{{");
      expect(doc).toContain(TEMPLATE_CSS);
    });

    it("throws on a missing placeholder value — never renders half-filled art", () => {
      expect(() => substituteTemplate(template, { title: "t", body: "b" })).toThrow(/page/);
    });

    it("escapeHtml covers the five metacharacters", () => {
      expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    });
  });
});

// Browser-backed render test — auto-skips where chromium isn't installed
// (e.g. CI without `playwright install`), per the part spec. The substitution
// and escaping logic above is covered without a browser either way.
const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    const { existsSync } = await import("node:fs");
    // executablePath() returns the *expected* path even when the browser was
    // never downloaded (e.g. CI without `playwright install`), so check the
    // binary actually exists on disk — otherwise the test runs and dies at launch.
    const path = chromium.executablePath();
    return Boolean(path) && existsSync(path);
  } catch {
    return false;
  }
})();

describe.runIf(chromiumAvailable)("renderer — headless chromium", () => {
  it("renders a PNG at the requested dimensions", async () => {
    const { closeRenderer } = await import("../src/design/render");
    try {
      const png = await renderSlide({
        template: {
          html: `<div style="display:flex;width:100%;height:100%;align-items:center;justify-content:center"><h1>{{title}}</h1></div>`,
          css: "body{background:#123;} h1{color:#fff;font-size:80px;}",
          placeholders: ["title"],
        },
        values: { title: "Hello Tuezday" },
        width: 640,
        height: 400,
      });
      expect(png.length).toBeGreaterThan(1000);
      // PNG header: bytes 16-19 width, 20-23 height (big-endian).
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      expect(view.getUint32(16)).toBe(640);
      expect(view.getUint32(20)).toBe(400);
    } finally {
      await closeRenderer();
    }
  }, 60_000);
});
