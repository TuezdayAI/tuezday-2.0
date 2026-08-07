import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createPreferenceRuleInputSchema,
  updatePreferenceRuleInputSchema,
  type PreferenceRuleStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { LlmGateway } from "../llm/gateway";
import { listPreferenceEdits } from "../services/preference-edits";
import { runPreferenceExtraction } from "../services/preference-extraction";
import {
  createManualRule,
  deletePreferenceRule,
  getPreferenceRule,
  listPreferenceRules,
  listRuleEvidence,
  setRuleStatus,
} from "../services/preference-rules";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalidInput(reply: FastifyReply, issues: { message: string }[]) {
  return reply.status(400).send({
    error: "invalid_input",
    message: issues.map((issue) => issue.message).join("; "),
  });
}

export interface PreferenceRouteDeps {
  llm: LlmGateway;
}

/**
 * Sprint 68: the founder's window onto preference memory. Every rule is
 * visible, attributable to the edits that taught it, and individually
 * reversible — which is the half of the PRD's acceptance criterion that has
 * nothing to do with generation quality and everything to do with trust.
 */
export function registerPreferenceRoutes(
  app: FastifyInstance,
  db: Db,
  deps: PreferenceRouteDeps,
): void {
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/workspaces/:id/preferences/rules",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const status = request.query.status as PreferenceRuleStatus | undefined;
      return { rules: await listPreferenceRules(db, request.params.id, { status }) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/preferences/rules",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createPreferenceRuleInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      return reply.status(201).send(await createManualRule(db, request.params.id, parsed.data));
    },
  );

  app.get<{ Params: { id: string; ruleId: string } }>(
    "/workspaces/:id/preferences/rules/:ruleId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const rule = await getPreferenceRule(db, request.params.id, request.params.ruleId);
      if (!rule) return reply.status(404).send({ error: "rule_not_found" });
      return { rule, evidence: await listRuleEvidence(db, rule.id) };
    },
  );

  app.patch<{ Params: { id: string; ruleId: string } }>(
    "/workspaces/:id/preferences/rules/:ruleId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updatePreferenceRuleInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const rule = await setRuleStatus(db, request.params.id, request.params.ruleId, parsed.data.status);
      if (!rule) return reply.status(404).send({ error: "rule_not_found" });
      return rule;
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/workspaces/:id/preferences/rules/:ruleId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      if (!await deletePreferenceRule(db, request.params.id, request.params.ruleId)) {
        return reply.status(404).send({ error: "rule_not_found" });
      }
      return reply.status(204).send();
    },
  );

  // The captured corrections themselves — so "nothing has been learned yet" is
  // distinguishable from "nothing has been captured yet".
  app.get<{ Params: { id: string }; Querystring: { digested?: string } }>(
    "/workspaces/:id/preferences/edits",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const digested =
        request.query.digested === undefined ? undefined : request.query.digested === "true";
      return { edits: await listPreferenceEdits(db, request.params.id, { digested }) };
    },
  );

  // Same pass the worker tick runs, on demand — the founder does not have to
  // wait out an interval to see what their morning's edits taught the system.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/preferences/extract",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return reply
        .status(200)
        .send(await runPreferenceExtraction(db, deps.llm, request.params.id));
    },
  );
}
