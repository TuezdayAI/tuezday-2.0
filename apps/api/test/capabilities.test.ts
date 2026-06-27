import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAuthedApp, createTestDb } from "./helpers";
import type { TuezdayApp } from "../src/app";
import { workspaceCapabilitiesSchema } from "@tuezday/contracts";

describe("GET /workspaces/:id/capabilities", () => {
  let app: TuezdayApp;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns defaults for a fresh workspace", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Solo" } })
    ).json();
    
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${created.id}/capabilities`
    });
    
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(workspaceCapabilitiesSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      hasAds: false,
      hasInsights: false,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0
    });
  });
  
  it("returns 404 for non-existent workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/nope/capabilities`
    });
    
    expect(res.statusCode).toBe(404);
  });
});
