import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  audienceSchema,
  evaluateSegment,
  personSchema,
  type Person,
  type SegmentRuleGroup,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { connections, crmContacts } from "../src/db/schema";
import { buildAuthedApp, createTestDb } from "./helpers";

function person(over: Partial<Person> = {}): Person {
  return {
    type: "lead",
    id: randomUUID(),
    name: "Dana Vee",
    email: "dana@fintechco.com",
    company: "FintechCo",
    role: "VP Marketing",
    ...over,
  };
}

// "VPs at fintech": role contains VP AND (company contains fintech OR domain contains fintech).
const VPS_AT_FINTECH: SegmentRuleGroup = {
  combinator: "and",
  rules: [
    { field: "role", operator: "contains", value: "VP" },
    {
      combinator: "or",
      rules: [
        { field: "company", operator: "contains", value: "fintech" },
        { field: "email_domain", operator: "contains", value: "fintech" },
      ],
    },
  ],
};

describe("segment evaluator (contracts, pure)", () => {
  it("matches a VP at a fintech company", () => {
    expect(evaluateSegment(person({ role: "VP Sales", company: "FintechCo" }), VPS_AT_FINTECH)).toBe(true);
  });

  it("matches a VP by email domain even when the company name does not say fintech", () => {
    const p = person({ role: "VP Sales", company: "Acme", email: "evan@fintech.io" });
    expect(evaluateSegment(p, VPS_AT_FINTECH)).toBe(true);
  });

  it("rejects a non-VP at a fintech company (AND fails)", () => {
    const p = person({ role: "Engineer", company: "FintechCo", email: "f@fintechco.com" });
    expect(evaluateSegment(p, VPS_AT_FINTECH)).toBe(false);
  });

  it("rejects a VP outside fintech (OR fails)", () => {
    const p = person({ role: "VP Product", company: "Healthwise", email: "g@health.com" });
    expect(evaluateSegment(p, VPS_AT_FINTECH)).toBe(false);
  });

  it("supports is_set / is_empty / equals / starts_with / type", () => {
    const p = person({ role: "", company: "Acme", type: "contact" });
    expect(evaluateSegment(p, { combinator: "and", rules: [{ field: "role", operator: "is_empty" }] })).toBe(true);
    expect(evaluateSegment(p, { combinator: "and", rules: [{ field: "company", operator: "is_set" }] })).toBe(true);
    expect(
      evaluateSegment(p, { combinator: "and", rules: [{ field: "company", operator: "equals", value: "acme" }] }),
    ).toBe(true);
    expect(
      evaluateSegment(p, { combinator: "and", rules: [{ field: "company", operator: "starts_with", value: "ac" }] }),
    ).toBe(true);
    expect(
      evaluateSegment(p, { combinator: "and", rules: [{ field: "type", operator: "equals", value: "contact" }] }),
    ).toBe(true);
  });

  it("treats an empty rule group as matching everyone", () => {
    expect(evaluateSegment(person(), { combinator: "and", rules: [] })).toBe(true);
  });
});

describe("audiences API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Aud" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  // --- seeding helpers --------------------------------------------------------

  async function createLead(over: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/leads`,
      payload: { name: "Lead", email: `${randomUUID()}@x.io`, company: "", role: "", ...over },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  function seedConnection(): string {
    const id = randomUUID();
    db.insert(connections)
      .values({
        id,
        workspaceId,
        providerKey: "freshsales",
        nangoConnectionId: `ws-${workspaceId}-freshsales`,
        configJson: "{}",
        status: "connected",
        lastCheckedAt: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    return id;
  }

  function seedContact(connectionId: string, over: Partial<{ name: string; email: string; company: string; role: string; leadId: string }> = {}): string {
    const id = randomUUID();
    db.insert(crmContacts)
      .values({
        id,
        workspaceId,
        connectionId,
        externalId: randomUUID(),
        name: over.name ?? "Contact",
        email: over.email ?? `${randomUUID()}@crm.io`,
        company: over.company ?? "",
        role: over.role ?? "",
        leadId: over.leadId ?? null,
        lastSyncedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    return id;
  }

  async function createAudience(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences`, payload });
  }

  async function getDetail(audienceId: string) {
    return (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/audiences/${audienceId}` })
    ).json();
  }

  // --- CRUD -------------------------------------------------------------------

  describe("CRUD", () => {
    it("creates a static list and a dynamic segment", async () => {
      const staticRes = await createAudience({ name: "My picks", kind: "static" });
      expect(staticRes.statusCode).toBe(201);
      const list = staticRes.json();
      expect(audienceSchema.safeParse(list).success).toBe(true);
      expect(list.kind).toBe("static");
      expect(list.rules).toBeNull();
      expect(list.memberCount).toBe(0);

      const segRes = await createAudience({ name: "VPs", kind: "dynamic", rules: VPS_AT_FINTECH });
      expect(segRes.statusCode).toBe(201);
      expect(segRes.json().kind).toBe("dynamic");
      expect(segRes.json().rules.combinator).toBe("and");
    });

    it("rejects an empty name", async () => {
      expect((await createAudience({ name: " ", kind: "static" })).statusCode).toBe(400);
    });

    it("rejects a dynamic segment without rules and a static list with rules", async () => {
      expect((await createAudience({ name: "S", kind: "dynamic" })).statusCode).toBe(400);
      expect(
        (await createAudience({ name: "S", kind: "static", rules: VPS_AT_FINTECH })).statusCode,
      ).toBe(400);
    });

    it("rejects an over-deep rule tree", async () => {
      let group: SegmentRuleGroup = { combinator: "and", rules: [{ field: "role", operator: "is_set" }] };
      for (let i = 0; i < 6; i++) group = { combinator: "and", rules: [group] };
      expect((await createAudience({ name: "Deep", kind: "dynamic", rules: group })).statusCode).toBe(400);
    });

    it("lists audiences with member counts and 404s unknown ones", async () => {
      await createAudience({ name: "A", kind: "static" });
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/audiences` })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0]).toHaveProperty("memberCount");
      const missing = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/audiences/${randomUUID()}`,
      });
      expect(missing.statusCode).toBe(404);
    });

    it("updates and deletes an audience", async () => {
      const a = (await createAudience({ name: "A", kind: "static" })).json();
      const upd = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/audiences/${a.id}`,
        payload: { name: "Renamed", kind: "static" },
      });
      expect(upd.statusCode).toBe(200);
      expect(upd.json().name).toBe("Renamed");

      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/audiences/${a.id}`,
      });
      expect(del.statusCode).toBe(204);
      expect(
        (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/audiences/${a.id}` })).statusCode,
      ).toBe(404);
    });
  });

  // --- people pool ------------------------------------------------------------

  describe("people pool", () => {
    it("returns leads plus unlinked contacts, and represents a linked contact once", async () => {
      const lead = await createLead({ name: "Asha", email: "asha@acme.io" });
      await createLead({ name: "Ben", email: "ben@acme.io" });
      const conn = seedConnection();
      seedContact(conn, { name: "Unlinked", email: "u@crm.io" });
      seedContact(conn, { name: "Linked", email: "asha@acme.io", leadId: lead.id });

      const people = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/people` })
      ).json();
      expect(people).toHaveLength(3); // 2 leads + 1 unlinked contact
      expect(people.every((p: unknown) => personSchema.safeParse(p).success)).toBe(true);
      const names = people.map((p: Person) => p.name).sort();
      expect(names).toEqual(["Asha", "Ben", "Unlinked"]);
    });
  });

  // --- static membership ------------------------------------------------------

  describe("static membership", () => {
    it("adds (idempotently), removes, and drops a deleted lead", async () => {
      const lead = await createLead({ name: "Asha", email: "asha@acme.io" });
      const conn = seedConnection();
      const contactId = seedContact(conn, { name: "Cara", email: "cara@crm.io" });
      const list = (await createAudience({ name: "Picks", kind: "static" })).json();

      const add = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences/${list.id}/members`,
        payload: { members: [{ type: "lead", id: lead.id }, { type: "contact", id: contactId }] },
      });
      expect(add.statusCode).toBe(200);
      expect(add.json().added).toBe(2);
      expect((await getDetail(list.id)).members).toHaveLength(2);

      // idempotent re-add
      const again = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences/${list.id}/members`,
        payload: { members: [{ type: "lead", id: lead.id }] },
      });
      expect(again.json().added).toBe(0);

      // remove the contact
      const rm = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/audiences/${list.id}/members/contact/${contactId}`,
      });
      expect(rm.statusCode).toBe(204);
      expect((await getDetail(list.id)).members).toHaveLength(1);

      // deleting the lead drops it from the list
      await app.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/leads/${lead.id}` });
      expect((await getDetail(list.id)).members).toHaveLength(0);
    });

    it("refuses adding members to a dynamic segment", async () => {
      const lead = await createLead();
      const seg = (await createAudience({ name: "Seg", kind: "dynamic", rules: VPS_AT_FINTECH })).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences/${seg.id}/members`,
        payload: { members: [{ type: "lead", id: lead.id }] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_a_static_list");
    });

    it("refuses a member that is not in the pool", async () => {
      const list = (await createAudience({ name: "Picks", kind: "static" })).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences/${list.id}/members`,
        payload: { members: [{ type: "lead", id: randomUUID() }] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("member_not_found");
    });
  });

  // --- dynamic resolution -----------------------------------------------------

  describe("dynamic resolution", () => {
    it("resolves 'VPs at fintech' live and re-resolves after a rule edit", async () => {
      await createLead({ name: "Dana", role: "VP Marketing", company: "FintechCo", email: "dana@x.io" });
      await createLead({ name: "Evan", role: "VP Sales", company: "Acme", email: "evan@fintech.io" });
      await createLead({ name: "Frank", role: "Engineer", company: "FintechCo", email: "frank@fintechco.com" });
      const conn = seedConnection();
      seedContact(conn, { name: "Gita", role: "VP Product", company: "Healthwise", email: "gita@health.com" });

      const seg = (await createAudience({ name: "VPs at fintech", kind: "dynamic", rules: VPS_AT_FINTECH })).json();
      const members = (await getDetail(seg.id)).members;
      expect(members.map((m: Person) => m.name).sort()).toEqual(["Dana", "Evan"]);

      // Broaden to "any VP" → Gita joins.
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/audiences/${seg.id}`,
        payload: {
          name: "VPs at fintech",
          kind: "dynamic",
          rules: { combinator: "and", rules: [{ field: "role", operator: "contains", value: "VP" }] },
        },
      });
      const broadened = (await getDetail(seg.id)).members;
      expect(broadened.map((m: Person) => m.name).sort()).toEqual(["Dana", "Evan", "Gita"]);
    });
  });

  // --- campaign attachment ----------------------------------------------------

  describe("campaign attachment", () => {
    async function createCampaign() {
      return (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Q3 push" },
        })
      ).json();
    }

    it("attaches audiences to a campaign and lists them on the campaign detail", async () => {
      const campaign = await createCampaign();
      const a = (await createAudience({ name: "List A", kind: "static" })).json();
      const b = (await createAudience({ name: "Seg B", kind: "dynamic", rules: VPS_AT_FINTECH })).json();

      const attachA = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences`,
        payload: { audienceId: a.id },
      });
      expect(attachA.statusCode).toBe(201);
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences`,
        payload: { audienceId: b.id },
      });

      const detail = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns/${campaign.id}` })
      ).json();
      expect(detail.audiences).toHaveLength(2);
      expect(detail.audiences.map((x: { name: string }) => x.name).sort()).toEqual(["List A", "Seg B"]);

      // idempotent re-attach
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences`,
        payload: { audienceId: a.id },
      });
      const stillTwo = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences` })
      ).json();
      expect(stillTwo).toHaveLength(2);

      // detach
      const detach = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences/${a.id}`,
      });
      expect(detach.statusCode).toBe(204);
      const afterDetach = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences` })
      ).json();
      expect(afterDetach).toHaveLength(1);
    });

    it("404s attaching an unknown audience or to an unknown campaign", async () => {
      const campaign = await createCampaign();
      const unknownAud = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/audiences`,
        payload: { audienceId: randomUUID() },
      });
      expect(unknownAud.statusCode).toBe(404);
      expect(unknownAud.json().error).toBe("audience_not_found");

      const a = (await createAudience({ name: "List A", kind: "static" })).json();
      const unknownCampaign = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${randomUUID()}/audiences`,
        payload: { audienceId: a.id },
      });
      expect(unknownCampaign.statusCode).toBe(404);
      expect(unknownCampaign.json().error).toBe("campaign_not_found");
    });
  });
});
