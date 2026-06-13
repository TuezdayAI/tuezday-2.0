import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("GET /health", () => {
  let app: TuezdayApp;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns ok with db connectivity", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });
});
