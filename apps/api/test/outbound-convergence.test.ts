import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { emailRecipientPermissions, workspaceEmailSenders } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  CsvOutboundExporter,
  type OutboundExport,
  type OutboundExporter,
  type OutboundRecipientMessage,
} from "../src/outbound/exporter";
import type {
  OutboundEmailDomain,
  OutboundEmailMessage,
  OutboundEmailProvider,
} from "../src/outbound-email/provider";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

/**
 * Sprint 51 — outbound strategy convergence.
 *
 * Email sends natively through the governed external-action boundary. The CSV
 * exporter is an export-only affordance: a founder can download their approved
 * copy, but no send or dispatch path may ever route through it. These tests are
 * the guard for that invariant.
 */

const fakeLlm: LlmGateway = {
  async generate() {
    // Deliberately single-line: keeps one CSV row per recipient so the export
    // assertions below can split on newlines.
    return {
      text: "Generated first-touch message.",
      model: "fake",
      provider: "fake",
      durationMs: 2,
    };
  },
};
const WORKER_TOKEN = "outbound-convergence-worker-token";

class FakeOutboundEmailProvider implements OutboundEmailProvider {
  send = vi.fn(async (_message: OutboundEmailMessage) => ({
    provider: "resend" as const,
    messageId: `email_${randomUUID()}`,
    acceptedAt: Date.now(),
  }));
  async createDomain(): Promise<OutboundEmailDomain> { throw new Error("unused"); }
  async verifyDomain(): Promise<void> { throw new Error("unused"); }
  async getDomain(): Promise<OutboundEmailDomain> { throw new Error("unused"); }
}

/** Records every export() call while behaving exactly like the real CSV exporter. */
class SpyOutboundExporter implements OutboundExporter {
  readonly format = "csv";
  readonly calls: OutboundRecipientMessage[][] = [];
  private readonly inner = new CsvOutboundExporter();

  export(messages: OutboundRecipientMessage[]): OutboundExport {
    this.calls.push(messages);
    return this.inner.export(messages);
  }
}

describe("outbound strategy convergence (Sprint 51)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let exporter: SpyOutboundExporter;
  let emailProvider: FakeOutboundEmailProvider;

  beforeEach(async () => {
    db = await createTestDb();
    exporter = new SpyOutboundExporter();
    emailProvider = new FakeOutboundEmailProvider();
    app = await buildAuthedApp({
      db,
      llm: fakeLlm,
      exporter,
      outboundEmail: emailProvider,
      workerToken: WORKER_TOKEN,
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Converge" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    // Sends run without a separate authorization hop so provider behaviour stays
    // observable; the authorization queue itself is covered elsewhere.
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  async function verifySender(): Promise<void> {
    const now = Date.now();
    await db.insert(workspaceEmailSenders)
      .values({
        workspaceId,
        domain: "example.com",
        fromLocalPart: "hello",
        fromName: "Converge",
        fromAddress: "hello@example.com",
        replyTo: null,
        status: "verified",
        provider: "resend",
        providerDomainId: "domain_123",
        dnsRecordsJson: "[]",
        killSwitch: false,
        dailyCap: 100,
        lastCheckedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  async function allowRecipient(email: string): Promise<void> {
    const now = Date.now();
    await db.insert(emailRecipientPermissions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail: email,
        status: "allowed",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [emailRecipientPermissions.workspaceId, emailRecipientPermissions.normalizedEmail],
        set: { status: "allowed", updatedAt: now },
      });
  }

  async function createLead(name: string): Promise<{ id: string; email: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/leads`,
      payload: {
        name,
        email: `${name.toLowerCase()}@acme.com`,
        company: "Acme",
        role: "VP",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function emailLaunch(): Promise<{ launchId: string; recipientEmail: string }> {
    const lead = await createLead("Alice");
    const audienceId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences`,
        payload: { name: "Targets", kind: "static" },
      })
    ).json().id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`,
      payload: { members: [{ type: "lead", id: lead.id }] },
    });
    const launchId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: { name: "Converge", audienceId, channels: ["email"] },
      })
    ).json().id;
    const generated = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/generate`,
      payload: {},
    });
    expect(generated.statusCode).toBe(202);
    const tick = await app.inject({
      method: "POST",
      url: "/internal/background-jobs/tick",
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {},
    });
    expect(tick.statusCode).toBe(200);
    expect(tick.json()).toMatchObject({ succeeded: 1 });
    return { launchId, recipientEmail: lead.email };
  }

  function launchDetail(launchId: string) {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/launches/${launchId}` })
      .then((r) => r.json());
  }

  async function approveLaunchDrafts(launchId: string): Promise<void> {
    const d = await launchDetail(launchId);
    for (const message of d.messages as Array<{ draftId: string | null }>) {
      if (!message.draftId) continue;
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${message.draftId}/approve`,
      });
      expect(res.statusCode).toBe(200);
    }
  }

  async function approvedLeadDraft(leadId: string): Promise<{ id: string }> {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outbound/draft`,
      payload: { leadIds: [leadId] },
    });
    const draft = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
    ).json()[0];
    const approved = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    return draft;
  }

  // -------------------------------------------------------------------------
  // (i) native send never touches the exporter
  // -------------------------------------------------------------------------

  describe("native send does not route through the exporter", () => {
    it("dispatches a launch email natively without invoking the exporter", async () => {
      const { launchId, recipientEmail } = await emailLaunch();
      await approveLaunchDrafts(launchId);
      await verifySender();
      await allowRecipient(recipientEmail);

      const dispatch = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches/${launchId}/channels/email/dispatch`,
        payload: {},
      });
      expect(dispatch.statusCode).toBe(200);
      const submission = dispatch.json().submissions[0];
      expect(submission.action.kind).toBe("send");
      expect(submission.execution.status).toBe("accepted");
      expect(emailProvider.send).toHaveBeenCalledTimes(1);

      const detail = await launchDetail(launchId);
      expect(detail.messages[0].status).toBe("sent");
      expect(exporter.calls).toHaveLength(0);
    });

    it("sends an approved outbound draft natively without invoking the exporter", async () => {
      const lead = await createLead("Bob");
      const draft = await approvedLeadDraft(lead.id);
      await verifySender();
      await allowRecipient(lead.email);

      const send = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/drafts/${draft.id}/send`,
        payload: {},
      });
      expect(send.statusCode).toBe(200);
      expect(send.json().execution.status).toBe("accepted");
      expect(emailProvider.send).toHaveBeenCalledTimes(1);
      expect(exporter.calls).toHaveLength(0);
    });

    it("blocks on sender_unverified instead of falling back to the exporter", async () => {
      const { launchId, recipientEmail } = await emailLaunch();
      await approveLaunchDrafts(launchId);
      await allowRecipient(recipientEmail); // permission is fine — no verified sender

      const dispatch = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches/${launchId}/channels/email/dispatch`,
        payload: {},
      });
      expect(dispatch.statusCode).toBe(200);
      expect(dispatch.json().submissions[0].action).toMatchObject({
        status: "blocked",
        blocker: { code: "sender_unverified" },
      });
      expect(emailProvider.send).not.toHaveBeenCalled();
      // The remedy is verifying a sender, not exporting to another tool.
      expect(exporter.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // (ii) the export-only affordance still works
  // -------------------------------------------------------------------------

  describe("CSV stays available as an export-only affordance", () => {
    it("exports approved launch email as CSV through the exporter", async () => {
      const { launchId } = await emailLaunch();
      await approveLaunchDrafts(launchId);

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("tuezday-launch-email.csv");
      const lines = res.body.trim().split("\n");
      expect(lines[0]).toBe("email,first_name,last_name,company,role,personalized_message");
      expect(lines).toHaveLength(2); // header + Alice
      expect(lines[1]).toContain("alice@acme.com");

      // Downloading is the only thing that reaches the exporter, and it sends nothing.
      expect(exporter.calls).toHaveLength(1);
      expect(exporter.calls[0]).toHaveLength(1);
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it("exports approved lead drafts from the outbound CSV endpoint", async () => {
      const lead = await createLead("Carol");
      await approvedLeadDraft(lead.id);

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/outbound/export.csv`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const lines = res.body.trim().split("\n");
      expect(lines[0]).toBe("name,email,company,role,channel,content");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("carol@acme.com");
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it("drops natively-sent messages from the export — one send path, not two", async () => {
      const { launchId, recipientEmail } = await emailLaunch();
      await approveLaunchDrafts(launchId);
      await verifySender();
      await allowRecipient(recipientEmail);
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches/${launchId}/channels/email/dispatch`,
        payload: {},
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.trim().split("\n")).toHaveLength(1); // header only
      expect(exporter.calls[0]).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // (iii) static guard — no send/dispatch path may reference the exporter
  // -------------------------------------------------------------------------

  describe("source guard", () => {
    const SRC = fileURLToPath(new URL("../src/", import.meta.url));

    /** Every .ts file under apps/api/src. */
    function sourceFiles(dir = SRC, acc: string[] = []): string[] {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, acc);
        else if (entry.name.endsWith(".ts")) acc.push(full);
      }
      return acc;
    }

    it("references the exporter only from the export seam and its wiring", () => {
      const allowed = new Set([
        "outbound/exporter.ts", // the seam itself
        "app.ts", // composition root injects it
        "routes/launches.ts", // GET .../export.csv
        "services/launches.ts", // exportLaunchEmail()
      ]);
      const offenders = sourceFiles()
        .filter((file) => /\bexporter\b/i.test(readFileSync(file, "utf8")))
        .map((file) => file.slice(SRC.length))
        .filter((rel) => !allowed.has(rel));
      expect(offenders).toEqual([]);
    });

    it("keeps the exporter out of dispatchChannel", () => {
      const source = readFileSync(join(SRC, "services/launches.ts"), "utf8");
      const start = source.indexOf("export async function dispatchChannel");
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf("\n}\n", start);
      expect(end).toBeGreaterThan(start);
      expect(source.slice(start, end)).not.toMatch(/exporter/i);
    });

    it("keeps the exporter out of every native email send path", () => {
      for (const rel of [
        "services/launch-sequences.ts",
        "services/external-action-email.ts",
        "services/external-action-coordinator.ts",
        "routes/outbound.ts",
      ]) {
        expect(readFileSync(join(SRC, rel), "utf8")).not.toMatch(/exporter/i);
      }
    });
  });
});
