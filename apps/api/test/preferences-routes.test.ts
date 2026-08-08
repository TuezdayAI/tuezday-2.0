import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preferenceRuleSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import type { GenerateResult, LlmGateway } from "../src/llm/gateway";
import { GatewayError } from "../src/llm/gateway";
import { applyDraftAction, getDraft } from "../src/services/drafts";
import { buildAuthedApp, createTestDb, registerUser } from "./helpers";

const ORIGINAL =
  "Should you charge per seat? Here is what everyone gets wrong about pricing pages this year.";

/** Generation for the seeded draft, then one canned extraction. */
class RouteGateway implements LlmGateway {
  private extractions: string[] = [];
  queue(extraction: unknown): void {
    this.extractions.push(JSON.stringify(extraction));
  }
  async generate(params: { prompt: string }): Promise<GenerateResult> {
    if (params.prompt.includes("durable writing preferences")) {
      const next = this.extractions.shift();
      if (next === undefined) throw new GatewayError("provider_error", "no extraction scripted");
      return { text: next, model: "fake", provider: "fake", durationMs: 1 };
    }
    return { text: ORIGINAL, model: "fake", provider: "fake", durationMs: 1 };
  }
}

describe("preferences API (Sprint 68)", () => {
  let app: TuezdayApp;
  let db: Db;
  let llm: RouteGateway;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    llm = new RouteGateway();
    app = await buildAuthedApp({ db, llm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Memory" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedEdit(): Promise<void> {
    const generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json().id;
    const draftId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
      })
    ).json().id;
    const edited = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/edit`,
      payload: {
        content: "We moved 40 customers to usage-based billing. Per-seat hid the churn.",
      },
    });
    expect(edited.statusCode).toBe(200);
  }

  it("captures an edit made through the gate and lists it", async () => {
    await seedEdit();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/edits`,
    });
    expect(res.statusCode).toBe(200);
    const { edits } = res.json();
    expect(edits).toHaveLength(1);
    expect(edits[0].digestedAt).toBeNull();
    expect(edits[0].source).toBe("draft_edit");
  });

  it("extracts on demand and exposes the rule with its evidence", async () => {
    await seedEdit();
    llm.queue({
      rules: [
        {
          rule: "Never open with a rhetorical question",
          polarity: "avoid",
          confidence: 85,
          evidence: "the founder replaced the opening question with a result",
        },
      ],
    });

    const extract = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/preferences/extract`,
    });
    expect(extract.statusCode).toBe(200);
    expect(extract.json()).toMatchObject({ edits: 1, created: 1 });

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/rules`,
    });
    const rule = preferenceRuleSchema.parse(list.json().rules[0]);
    expect(rule.status).toBe("active");

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/rules/${rule.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.evidence).toHaveLength(1);
    // Attributable: the evidence points back at the founder's actual edit.
    expect(body.evidence[0].edit.afterContent).toContain("usage-based billing");
  });

  it("lets the founder write a rule by hand and switch it off again", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/preferences/rules`,
      payload: { rule: "Name the segment, not the persona", scopeChannel: "linkedin" },
    });
    expect(created.statusCode).toBe(201);
    const rule = preferenceRuleSchema.parse(created.json());
    expect(rule.status).toBe("active");
    expect(rule.origin).toBe("manual");

    const off = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/preferences/rules/${rule.id}`,
      payload: { status: "disabled" },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().status).toBe("disabled");

    const removed = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/preferences/rules/${rule.id}`,
    });
    expect(removed.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/rules`,
    });
    expect(after.json().rules).toHaveLength(0);
  });

  it("refuses a rule that is a paragraph, and a status it does not own", async () => {
    const tooLong = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/preferences/rules`,
      payload: { rule: "x".repeat(200) },
    });
    expect(tooLong.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/preferences/rules`,
      payload: { rule: "Name the segment, not the persona" },
    });
    const ruleId = created.json().id;
    // Promotion belongs to an accepted synthesis, never to a button.
    const promote = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/preferences/rules/${ruleId}`,
      payload: { status: "promoted" },
    });
    expect(promote.statusCode).toBe(400);
  });

  it("404s an unknown rule rather than inventing one", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/rules/66666666-6666-4666-8666-666666666666`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("keeps one workspace's taste out of another's", async () => {
    const stranger = await registerUser(app, "stranger@test.dev", "stranger");
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/rules`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not capture the worker's own edits (D-68.2)", async () => {
    const generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      })
    ).json().id;
    const draftId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
      })
    ).json().id;
    await applyDraftAction(
      db,
      (await getDraft(db, workspaceId, draftId))!,
      "edit",
      { userId: null, label: "system", human: false },
      "A machine rewrite that nobody asked for and nothing should learn from.",
    );

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/preferences/edits`,
    });
    expect(res.json().edits).toHaveLength(0);
  });
});
