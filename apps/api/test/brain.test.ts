import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_DOC_MAX_CHARS, brainDocumentSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import { createTestDb } from "./helpers";

describe("brain API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb() });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Brainy" },
    });
    workspaceId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /workspaces/:id/brain", () => {
    it("returns five empty docs in canonical order for a new workspace", async () => {
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs).toHaveLength(5);
      expect(body.docs.map((d: { docType: string }) => d.docType)).toEqual([
        "soul",
        "icp",
        "voice",
        "history",
        "now",
      ]);
      for (const doc of body.docs) {
        expect(brainDocumentSchema.safeParse(doc).success).toBe(true);
        expect(doc.content).toBe("");
        expect(doc.workspaceId).toBe(workspaceId);
      }
    });

    it("includes a completeness score starting at 0", async () => {
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` });
      const body = res.json();
      expect(body.completeness.percent).toBe(0);
      expect(body.completeness.docs).toHaveLength(5);
    });

    it("returns 404 for an unknown workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/brain",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("workspace_not_found");
    });
  });

  describe("CORS preflight", () => {
    it("allows PUT from the web app origin", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: `/workspaces/${workspaceId}/brain/soul`,
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(res.headers["access-control-allow-methods"]).toContain("PUT");
      expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    });
  });

  describe("PUT /workspaces/:id/brain/:docType", () => {
    it("saves content and returns the updated doc", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "We exist to end GTM amnesia." },
      });
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.docType).toBe("soul");
      expect(doc.content).toBe("We exist to end GTM amnesia.");
      expect(doc.updatedAt).toBeGreaterThanOrEqual(doc.createdAt);
    });

    it("persists the save", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/voice`,
        payload: { content: "Direct, technical." },
      });
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` });
      const voice = res.json().docs.find((d: { docType: string }) => d.docType === "voice");
      expect(voice.content).toBe("Direct, technical.");
    });

    it("updates completeness after saves", async () => {
      const fortyWords = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: fortyWords },
      });
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/brain` });
      expect(res.json().completeness.percent).toBe(20); // 1 of 5 complete
    });

    it("rejects an unknown doc type with 400", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/strategy`,
        payload: { content: "nope" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_doc_type");
    });

    it("rejects oversized content with 400", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "x".repeat(BRAIN_DOC_MAX_CHARS + 1) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    });

    it("rejects a missing content field with 400", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown workspace", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/brain/soul",
        payload: { content: "hello" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /workspaces/:id/brain/:docType/versions", () => {
    it("starts with no versions", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain/soul/versions`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("records a version per save, newest first", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "First take." },
      });
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "Second take." },
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain/soul/versions`,
      });
      const versions = res.json();
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[0].content).toBe("Second take.");
      expect(versions[1].version).toBe(1);
      expect(versions[1].content).toBe("First take.");
    });

    it("keeps versions separate per doc type", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "Soul content." },
      });
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain/icp/versions`,
      });
      expect(res.json()).toEqual([]);
    });

    it("rejects an unknown doc type with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain/strategy/versions`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /workspaces/:id/brain/export", () => {
    it("exports the brain as markdown with all five sections", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/brain/soul`,
        payload: { content: "We exist to end GTM amnesia." },
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/brain/export`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.body).toContain("# Brainy — GTM Brain");
      expect(res.body).toContain("## Soul");
      expect(res.body).toContain("We exist to end GTM amnesia.");
      expect(res.body).toContain("## Now");
      expect(res.body).toContain("_Not written yet._");
    });

    it("returns 404 for an unknown workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/brain/export",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
