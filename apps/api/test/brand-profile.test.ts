import { afterEach, describe, expect, it } from "vitest";
import type { Fetcher } from "../src/discovery/adapters";
import type { LlmGateway } from "../src/llm/gateway";
import { GatewayError } from "../src/llm/gateway";
import { scrapeWebsite, stripHtml } from "../src/services/scrape";
import { BrandExtractError, extractBrandProfile } from "../src/services/brand-profile";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME_HTML = `<!doctype html>
<html><head><title>Hexalog</title><style>body{color:red}</style>
<script>console.log("hi")</script></head>
<body>
  <h1>Hexalog &mdash; logs, but hexagonal</h1>
  <p>Hexalog helps platform teams see production clearly.</p>
  <a href="/about">About us</a>
  <a href="/pricing">Pricing</a>
  <a href="https://twitter.com/hexalog">Twitter</a>
  <a href="/blog/post-1">Blog post</a>
</body></html>`;

const ABOUT_HTML = `<html><body><h2>About</h2><p>Founded in 2024 by SREs, for SREs.</p></body></html>`;
const PRICING_HTML = `<html><body><p>Free tier and a $49 pro plan.</p></body></html>`;

const GOOD_PROFILE_JSON = JSON.stringify({
  businessName: "Hexalog",
  tagline: "Logs, but hexagonal",
  summary: "Hexalog is a logging platform for platform teams.",
  targetAgeRange: "25-45",
  tone: "Confident and technical",
  voiceDimensions: {
    purpose: "Help platform teams see production clearly",
    audience: "Senior platform engineers",
    tone: "Direct",
    emotions: "Calm confidence",
    character: "The experienced SRE next desk over",
    syntax: "Short sentences",
    language: "US English",
  },
  pillars: ["Observability", "Cost control"],
  sourceNotes: "",
});

function siteFetcher(pages: Record<string, string>, urls: string[] = []): Fetcher {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    urls.push(u);
    const path = new URL(u).pathname;
    const body = pages[path];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as Fetcher;
}

function failingFetcher(): Fetcher {
  return (async () => {
    throw new Error("connection refused");
  }) as Fetcher;
}

/** Fake gateway: first `badCalls` responses are unparseable, then good JSON. */
function markerLlm(badCalls = 0): { llm: LlmGateway; calls: () => number } {
  let n = 0;
  return {
    llm: {
      async generate() {
        n += 1;
        if (n <= badCalls) {
          return { text: "Sure! Here's a great brand summary for you.", model: "fake", provider: "fake", durationMs: 1 };
        }
        return { text: "```json\n" + GOOD_PROFILE_JSON + "\n```", model: "fake", provider: "fake", durationMs: 1 };
      },
    },
    calls: () => n,
  };
}

function throwingLlm(): LlmGateway {
  return {
    async generate() {
      throw new GatewayError("missing_api_key", "GEMINI_API_KEY is not set.");
    },
  };
}

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  it("removes script/style blocks, tags and entities, collapses whitespace", () => {
    const text = stripHtml(HOME_HTML);
    expect(text).toContain("Hexalog — logs, but hexagonal");
    expect(text).toContain("see production clearly");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<");
    expect(text).not.toMatch(/\s{2,}/);
  });
});

// ---------------------------------------------------------------------------
// scrapeWebsite
// ---------------------------------------------------------------------------

describe("scrapeWebsite", () => {
  it("fetches the root and same-origin about-ish links only", async () => {
    const urls: string[] = [];
    const fetcher = siteFetcher(
      { "/": HOME_HTML, "/about": ABOUT_HTML, "/pricing": PRICING_HTML },
      urls,
    );
    const result = await scrapeWebsite("https://hexalog.com", fetcher);
    expect(result.corpus).toContain("see production clearly");
    expect(result.corpus).toContain("Founded in 2024");
    expect(result.corpus).toContain("$49 pro plan");
    expect(result.pagesFetched).toEqual([
      "https://hexalog.com/",
      "https://hexalog.com/about",
      "https://hexalog.com/pricing",
    ]);
    // never followed the external or blog links
    expect(urls.some((u) => u.includes("twitter"))).toBe(false);
    expect(urls.some((u) => u.includes("blog"))).toBe(false);
  });

  it("tolerates subpage failures and still returns the root corpus", async () => {
    const fetcher = siteFetcher({ "/": HOME_HTML }); // /about, /pricing 404
    const result = await scrapeWebsite("https://hexalog.com", fetcher);
    expect(result.corpus).toContain("see production clearly");
    expect(result.pagesFetched).toEqual(["https://hexalog.com/"]);
  });

  it("caps the corpus at 20000 chars", async () => {
    const big = `<html><body><p>${"word ".repeat(10000)}</p></body></html>`;
    const fetcher = siteFetcher({ "/": big });
    const result = await scrapeWebsite("https://hexalog.com", fetcher);
    expect(result.corpus.length).toBeLessThanOrEqual(20000);
  });

  it("throws when the root page cannot be fetched", async () => {
    await expect(scrapeWebsite("https://hexalog.com", failingFetcher())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractBrandProfile
// ---------------------------------------------------------------------------

describe("extractBrandProfile", () => {
  it("parses fenced JSON into a validated profile in one call", async () => {
    const { llm, calls } = markerLlm(0);
    const profile = await extractBrandProfile(llm, "corpus text");
    expect(profile.businessName).toBe("Hexalog");
    expect(profile.voiceDimensions.audience).toBe("Senior platform engineers");
    expect(calls()).toBe(1);
  });

  it("repairs once on an unparseable first response", async () => {
    const { llm, calls } = markerLlm(1);
    const profile = await extractBrandProfile(llm, "corpus text");
    expect(profile.businessName).toBe("Hexalog");
    expect(calls()).toBe(2);
  });

  it("throws BrandExtractError after two unparseable responses", async () => {
    const { llm, calls } = markerLlm(2);
    await expect(extractBrandProfile(llm, "corpus text")).rejects.toBeInstanceOf(
      BrandExtractError,
    );
    expect(calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// API flow
// ---------------------------------------------------------------------------

describe("brand profile API", () => {
  let app: TuezdayApp;

  afterEach(async () => {
    await app.close();
  });

  async function createWorkspace(withUrl = true) {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: withUrl
        ? { name: "Hexalog", websiteUrl: "https://hexalog.com", onboardingStep: "connect" }
        : { name: "Hexalog" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it("GET returns status none before any run", async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: markerLlm(0).llm, fetcher: siteFetcher({ "/": HOME_HTML }) });
    const ws = await createWorkspace(false);
    const res = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/brand-profile` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "none", profile: null });
  });

  it("refresh runs inline to ready and GET returns the profile", async () => {
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: markerLlm(0).llm,
      fetcher: siteFetcher({ "/": HOME_HTML, "/about": ABOUT_HTML, "/pricing": PRICING_HTML }),
    });
    const ws = await createWorkspace();
    const run = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brand-profile/refresh`,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe("ready");
    expect(run.json().profile.businessName).toBe("Hexalog");

    const got = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/brand-profile` });
    expect(got.json().status).toBe("ready");
    expect(got.json().sourceUrl).toBe("https://hexalog.com");
  });

  it("workspace creation with a websiteUrl triggers the run in the background", async () => {
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: markerLlm(0).llm,
      fetcher: siteFetcher({ "/": HOME_HTML }),
    });
    const ws = await createWorkspace();
    // fire-and-forget: give the inline promise a beat to finish
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/brand-profile` });
      const body = res.json();
      if (body.status === "ready") {
        expect(body.profile.businessName).toBe("Hexalog");
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("brand profile never became ready");
  });

  it("refresh without a websiteUrl → 400", async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: markerLlm(0).llm, fetcher: siteFetcher({}) });
    const ws = await createWorkspace(false);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brand-profile/refresh`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_website_url");
  });

  it("a failing scrape records status failed with the error", async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: markerLlm(0).llm, fetcher: failingFetcher() });
    const ws = await createWorkspace();
    const run = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brand-profile/refresh`,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe("failed");
    expect(run.json().error).toContain("connection refused");
  });

  it("a gateway failure records status failed", async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: throwingLlm(), fetcher: siteFetcher({ "/": HOME_HTML }) });
    const ws = await createWorkspace();
    const run = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brand-profile/refresh`,
    });
    expect(run.json().status).toBe("failed");
    expect(run.json().error).toContain("GEMINI_API_KEY");
  });

  it("PATCH edits fields once ready; 409 while not ready", async () => {
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: markerLlm(0).llm,
      fetcher: siteFetcher({ "/": HOME_HTML }),
    });
    const ws = await createWorkspace();
    await app.inject({ method: "POST", url: `/workspaces/${ws.id}/brand-profile/refresh` });

    const patch = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}/brand-profile`,
      payload: { tone: "Warmer and friendlier", pillars: ["Observability"] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().profile.tone).toBe("Warmer and friendlier");
    expect(patch.json().profile.businessName).toBe("Hexalog"); // untouched fields survive

    const got = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/brand-profile` });
    expect(got.json().profile.pillars).toEqual(["Observability"]);
  });

  it("PATCH before any run → 409", async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: markerLlm(0).llm, fetcher: siteFetcher({}) });
    const ws = await createWorkspace(false);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}/brand-profile`,
      payload: { tone: "x" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("PATCH with an invalid field → 400", async () => {
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: markerLlm(0).llm,
      fetcher: siteFetcher({ "/": HOME_HTML }),
    });
    const ws = await createWorkspace();
    await app.inject({ method: "POST", url: `/workspaces/${ws.id}/brand-profile/refresh` });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}/brand-profile`,
      payload: { businessName: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
