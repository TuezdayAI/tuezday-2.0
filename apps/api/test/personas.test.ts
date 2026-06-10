import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personaSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import { createTestDb } from "./helpers";

describe("personas API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb() });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Personable" },
    });
    workspaceId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a persona with defaults", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "CEO" },
    });
    expect(res.statusCode).toBe(201);
    const persona = res.json();
    expect(personaSchema.safeParse(persona).success).toBe(true);
    expect(persona.name).toBe("CEO");
    expect(persona.description).toBe("");
    expect(persona.overlay).toBe("");
  });

  it("rejects an empty name", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/personas",
      payload: { name: "CEO" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists personas", async () => {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "CEO" },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "Company page" },
    });
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/personas` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("updates a persona with a full replace", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO", overlay: "old overlay" },
      })
    ).json();

    const res = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/personas/${created.id}`,
      payload: { name: "CEO v2", description: "Founder voice", overlay: "new overlay" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.name).toBe("CEO v2");
    expect(updated.overlay).toBe("new overlay");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("deletes a persona", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Temp" },
      })
    ).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${created.id}`,
    });
    expect(del.statusCode).toBe(204);

    const list = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/personas` })
    ).json();
    expect(list).toHaveLength(0);
  });

  it("returns 404 updating or deleting an unknown persona", async () => {
    const missing = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const upd = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/personas/${missing}`,
      payload: { name: "Ghost" },
    });
    expect(upd.statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${missing}`,
    });
    expect(del.statusCode).toBe(404);
  });
});
