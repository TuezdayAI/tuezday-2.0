import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContext } from "@tuezday/brain";
import type { EvalRunMetrics } from "@tuezday/contracts";
import { createDb, type Db } from "../db";
import { drafts, signals, workspaces } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { ScriptedGateway } from "../llm/scripted";
import type { SafeFetchService } from "../safe-fetch/index";
import { addBannedClaim } from "../services/banned-claims";
import { createManualRule } from "../services/preference-rules";
import { failedCheckKinds } from "./golden-helpers";
import {
  buildEvalSuite,
  compareEvalRuns,
  runEvalSuite,
  type EvalHarnessDeps,
} from "../services/eval-harness";
import {
  ensurePipelineDefinitions,
  listPipelineDefinitions,
  setPipelineStatus,
} from "../services/pipeline-definitions";
import {
  GOLDEN_BANNED_CLAIMS,
  GOLDEN_CASES,
  GOLDEN_CTA_EXPECTATION,
  GOLDEN_PREFERENCE_RULE,
  GOLDEN_RESOLVER_INPUT,
  GOLDEN_RESOLVER_MUST_CONTAIN,
} from "./golden-cases";

/**
 * The CI gate (D-67.8). `npm run eval` runs this and exits non-zero on any of:
 * a broken context invariant, a moved context digest, a metric regression, or
 * an adversarial case that stopped failing. `npm run eval:record` re-records
 * expected.json — which is the point of the digest: an intentional prompt,
 * step, tool-description or resolver change has to be accepted in a diff.
 */

const EXPECTED_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../eval/golden/expected.json",
);

const SEED_BASE = 1_760_000_000_000;

export interface GoldenCaseOutcome {
  id: string;
  verdict: string | null;
  failedChecks: string[];
}

export interface GoldenOutcome {
  /** sha256 over every composed step system+user message, in order. */
  contextDigest: string;
  /** sha256 over the resolved legacy prompt and its section list. */
  resolverDigest: string;
  /** Replay metrics with `production` stripped — it moves with the clock. */
  metrics: EvalRunMetrics;
  cases: GoldenCaseOutcome[];
  /** Named invariants that no longer hold. Empty is the only acceptable value. */
  invariantFailures: string[];
}

export type GoldenExpectation = Pick<
  GoldenOutcome,
  "contextDigest" | "resolverDigest" | "metrics" | "cases"
>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seedWorkspace(db: Db): string {
  const workspaceId = randomUUID();
  const now = SEED_BASE;
  db.insert(workspaces)
    .values({ id: workspaceId, name: "Golden", createdAt: now, updatedAt: now })
    .run();
  for (const phrase of GOLDEN_BANNED_CLAIMS) {
    addBannedClaim(db, workspaceId, { phrase, note: "" });
  }
  // Sprint 68: one active learned rule, so every draft step's context carries
  // the preference block and the digest moves if that block ever changes.
  createManualRule(db, workspaceId, GOLDEN_PREFERENCE_RULE, now);
  // Newest first so buildEvalSuite's updatedAt-desc order matches fixture order,
  // which is what makes the scripted gateway's step sequence line up.
  GOLDEN_CASES.forEach((goldenCase, index) => {
    const signalId = randomUUID();
    const stamp = SEED_BASE - index;
    db.insert(signals)
      .values({
        id: signalId,
        workspaceId,
        content: goldenCase.signalContent,
        source: "other",
        sourceUrl: null,
        suggestedPersonaId: null,
        suggestedCampaignId: null,
        createdAt: stamp,
      })
      .run();
    db.insert(drafts)
      .values({
        id: randomUUID(),
        workspaceId,
        sourceGenerationId: null,
        sourceSignalId: signalId,
        campaignId: null,
        leadId: null,
        mediaContactId: null,
        taskType: "signal_response",
        channel: goldenCase.channel,
        personaId: null,
        originalContent: goldenCase.history.originalContent,
        content: goldenCase.history.content,
        state: goldenCase.history.state,
        automationKey: null,
        reviewJson: null,
        mediaJson: null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
  });
  return workspaceId;
}

/** Every agent step's system prompt plus the user message it was given. */
function transcript(gateway: ScriptedGateway): string[] {
  return gateway.calls.map((call) =>
    [call.system, ...call.messages.map((message) => String(message.content))].join("\n"),
  );
}

export async function runGoldenSuite(): Promise<GoldenOutcome> {
  const db = createDb(":memory:");
  const workspaceId = seedWorkspace(db);

  ensurePipelineDefinitions(db, workspaceId);
  const definition = listPipelineDefinitions(db, workspaceId)[0]!;
  setPipelineStatus(db, workspaceId, definition.id, "active");

  const { suite } = buildEvalSuite(
    db,
    workspaceId,
    {
      name: "golden",
      channel: "linkedin",
      ctaExpectation: GOLDEN_CTA_EXPECTATION,
      limit: GOLDEN_CASES.length,
    },
    { userId: null },
  );

  const gateway = new ScriptedGateway(GOLDEN_CASES.flatMap((goldenCase) => goldenCase.script));
  const deps: EvalHarnessDeps = {
    llm: gateway,
    evidence: {} as unknown as EvidenceStore,
    safeFetch: {} as unknown as SafeFetchService,
  };
  const run = await runEvalSuite(
    db,
    deps,
    workspaceId,
    { suiteId: suite.id, judge: false },
    { userId: null, label: "golden" },
  );

  const invariantFailures: string[] = [];

  // Each case contributes four agent calls: research, angle, draft, critique.
  const messages = transcript(gateway);
  GOLDEN_CASES.forEach((goldenCase, index) => {
    const draftMessage = messages[index * 4 + 2];
    if (draftMessage === undefined) {
      invariantFailures.push(`${goldenCase.id}: the draft step never reached the model.`);
      return;
    }
    for (const fragment of goldenCase.mustContain) {
      if (!draftMessage.includes(fragment)) {
        invariantFailures.push(
          `${goldenCase.id}: the draft step's context no longer contains "${fragment}".`,
        );
      }
    }
  });

  const resolved = resolveContext(GOLDEN_RESOLVER_INPUT);
  for (const fragment of GOLDEN_RESOLVER_MUST_CONTAIN) {
    if (!resolved.prompt.includes(fragment)) {
      invariantFailures.push(`resolver: the resolved prompt no longer contains "${fragment}".`);
    }
  }

  const byCase = new Map(run.results.map((result) => [result.caseId, result]));
  const orderedCaseIds = run.results.map((result) => result.caseId);
  const cases: GoldenCaseOutcome[] = GOLDEN_CASES.map((goldenCase, index) => {
    const result = byCase.get(orderedCaseIds[index] ?? "");
    return {
      id: goldenCase.id,
      verdict: result?.verdict ?? null,
      failedChecks: result ? failedCheckKinds(result.checks) : [],
    };
  });

  return {
    contextDigest: sha256(messages.join("\n---\n")),
    resolverDigest: sha256(
      [
        resolved.prompt,
        resolved.sections.map((section) => `${section.key}:${section.included}`).join(","),
      ].join("\n"),
    ),
    metrics: { ...run.metrics, production: null },
    cases,
    invariantFailures,
  };
}

export function loadExpected(): GoldenExpectation {
  return JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as GoldenExpectation;
}

export function writeExpected(outcome: GoldenOutcome): void {
  const expected: GoldenExpectation = {
    contextDigest: outcome.contextDigest,
    resolverDigest: outcome.resolverDigest,
    metrics: outcome.metrics,
    cases: outcome.cases,
  };
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(expected, null, 2)}\n`);
}

/** Every reason this run would block a merge, in the order a human should read them. */
export function checkGolden(
  outcome: GoldenOutcome,
  expected: GoldenExpectation,
): { ok: boolean; failures: string[] } {
  const failures = [...outcome.invariantFailures];

  const comparison = compareEvalRuns(
    { id: "current", metrics: outcome.metrics },
    { id: "golden", metrics: expected.metrics, baselineLabel: "golden" },
  );
  for (const regression of comparison.regressions) {
    failures.push(
      `metric regression: ${regression.metric} ${regression.baseline} → ${regression.current} (tolerance ±${regression.tolerance}).`,
    );
  }

  const expectedById = new Map(expected.cases.map((entry) => [entry.id, entry]));
  for (const current of outcome.cases) {
    const previous = expectedById.get(current.id);
    if (!previous) {
      failures.push(`${current.id}: new golden case — re-record expected.json.`);
      continue;
    }
    if (current.verdict !== previous.verdict) {
      failures.push(
        `${current.id}: verdict changed from ${previous.verdict} to ${current.verdict}.`,
      );
    }
    const before = previous.failedChecks.join(",");
    const after = current.failedChecks.join(",");
    if (before !== after) {
      failures.push(
        `${current.id}: failing checks changed from [${before}] to [${after}] — a check was weakened or a new one fires.`,
      );
    }
  }

  if (outcome.resolverDigest !== expected.resolverDigest) {
    failures.push(
      "resolver digest moved: the resolved context for the golden input changed. " +
        "If that was intentional, re-record with `npm run eval:record`.",
    );
  }
  if (outcome.contextDigest !== expected.contextDigest) {
    failures.push(
      "context digest moved: a prompt, step goal, tool allowlist or injected context changed. " +
        "If that was intentional, re-record with `npm run eval:record`.",
    );
  }

  return { ok: failures.length === 0, failures };
}
