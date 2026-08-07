// Sprint 71 (PRD §8, direction move 7b): "show the work".
//
// One assembler, four artifact kinds, one `ArtifactTrace` shape. Every block is
// read out of state the platform already wrote — no LLM call, no re-resolve
// (D-71.2). A "why" panel that recomputes shows you *a* bundle, not *the*
// bundle, and drifts from what the model actually saw as the workspace changes.
//
// The three non-draft kinds resolve THROUGH their artifact to the resolve that
// produced the words:
//
//   draft            → itself
//   publication      → publications.draft_id
//   external_action  → external_actions.draft_id (null for non-content actions)
//   deliverable      → latest variant → context_snapshots.resolved_context_json
//
// Leaf module: drizzle + contracts + brain + sibling leaf services only.

import { and, desc, eq } from "drizzle-orm";
import {
  TRACE_EXCERPT_MAX_CHARS,
  type ArtifactTrace,
  type Channel,
  type FindingsOutput,
  type GenerationReview,
  type TaskType,
  type TraceContextSection,
  type TraceCost,
  type TraceCritic,
  type TraceExample,
  type TraceOrigin,
  type TracePlan,
  type TracePreference,
  type TraceRevision,
  type TraceSubjectKind,
  findingsOutputSchema,
  generationReviewSchema,
} from "@tuezday/contracts";
import { estimateTokens, rankTexts, type ContextSection } from "@tuezday/brain";
import type { Db } from "../db";
import {
  campaigns,
  contentPackages,
  contextSnapshots,
  deliverables,
  draftRevisionTurns,
  drafts,
  externalActions,
  generations,
  pipelineRunSteps,
  pipelineRuns,
  preferenceRules,
  publications,
  signals,
  variants,
} from "../db/schema";
import { getCurrentCampaignPlan } from "./campaign-plans";
import { normalizedEditDistance } from "./edit-distance";
import { costCents, hasPricing } from "../llm/pricing";
import { normalizeRule } from "./preference-rules";
import { knobStatesForResolve, type KnobResolveMeta } from "./knob-usage";

const REVISION_LIMIT = 20;

function clip(text: string, max = TRACE_EXCERPT_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function title(text: string, max = 80): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length === 0 ? "Untitled" : clip(firstLine, max);
}

function parseSections(json: string | null | undefined): ContextSection[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ContextSection[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section → linked trace row
// ---------------------------------------------------------------------------

/**
 * Where a section came from, as a link the founder can follow. This is the
 * requirement "every trace element is a link to the thing that produced it";
 * a section with no honest destination gets `null` rather than a guess.
 */
function sectionHref(
  workspaceId: string,
  section: ContextSection,
  campaignId: string | null,
): string | null {
  const base = `/workspaces/${workspaceId}`;
  if (section.key.startsWith("org:") || section.key.startsWith("zoom:")) {
    const docType = section.key.split(":")[1]?.split("#")[0];
    return docType ? `${base}/brain?doc=${docType}` : `${base}/brain`;
  }
  switch (section.layer) {
    case "channel":
      return `${base}/guidance`;
    case "campaign":
    case "plan":
      return campaignId ? `${base}/campaigns/${campaignId}` : `${base}/campaigns`;
    case "persona":
      return `${base}/resolver`;
    case "evidence":
      return `${base}/evidence`;
    case "preferences":
      return `${base}/preferences`;
    case "examples":
      return `${base}/review?tab=approvals&state=all`;
    case "signal":
      return `${base}/discovery`;
    case "account":
    case "conversation":
      return `${base}/inbox`;
    case "lead":
      return `${base}/lists`;
    case "contact":
      return `${base}/pr`;
    default:
      return null;
  }
}

function toTraceSections(
  workspaceId: string,
  sections: ContextSection[],
  campaignId: string | null,
): TraceContextSection[] {
  return sections.map((section) => ({
    key: section.key,
    layer: section.layer,
    title: section.title,
    // The resolver's own words, never paraphrased — it already explains itself
    // better than a second explanation of the explanation would.
    reason: section.reason,
    tokens: section.tokens,
    included: section.included,
    tier: section.tier ?? null,
    mode: section.mode ?? null,
    zoomScore: section.zoom?.score ?? null,
    zoomRank: section.zoom?.rank ?? null,
    excerpt: clip(section.content),
    href: sectionHref(workspaceId, section, campaignId),
  }));
}

// ---------------------------------------------------------------------------
// Examples + preferences: parsed back out of the blocks the resolver rendered
// ---------------------------------------------------------------------------

/**
 * Mirrors `renderExamples` in `packages/brain/src/resolver.ts`:
 *   [A1](optional edited note)\n<content>
 *   [R1] (outcome)\n<content>\nWhy: <reason>
 *
 * Parsing what was rendered keeps D-71.2 intact — re-retrieving would show
 * today's nearest neighbours, not the ones this draft actually saw.
 */
export function parseExamplesSection(content: string): TraceExample[] {
  const examples: TraceExample[] = [];
  const blocks = content.split(/\n\n(?=\[[AR]\d+\])/);
  for (const block of blocks) {
    const match = /^\[([AR])(\d+)\]([^\n]*)\n([\s\S]*)$/.exec(block.trim());
    if (!match) continue;
    const [, letter, index, suffix, body] = match;
    const whyAt = body!.lastIndexOf("\nWhy: ");
    const why = whyAt === -1 ? null : clip(body!.slice(whyAt + 6), 300);
    const excerpt = clip(whyAt === -1 ? body! : body!.slice(0, whyAt));
    const outcome = /\(([^)]+)\)/.exec(suffix ?? "")?.[1] ?? null;
    examples.push({
      kind: letter === "A" ? "approved" : "rejected",
      label:
        letter === "A"
          ? `Approved example ${index}${suffix?.includes("edited") ? " (human-edited)" : ""}`
          : `${outcome ? outcome[0]!.toUpperCase() + outcome.slice(1) : "Rejected"} example ${index}`,
      excerpt,
      why,
      href: null,
    });
  }
  return examples;
}

/**
 * Mirrors `renderPreferences`: `- Do: <rule> [learned from N edits, <scope>]`.
 * The rule text is joined back to `preference_rules` by the same normalization
 * the store uses, so the panel can link to the live rule — or say plainly that
 * the rule has since been retired.
 */
export async function parsePreferencesSection(
  db: Db,
  workspaceId: string,
  content: string,
): Promise<TracePreference[]> {
  const live = await db
    .select({
      id: preferenceRules.id,
      rule: preferenceRules.rule,
      confidence: preferenceRules.confidence,
    })
    .from(preferenceRules)
    .where(eq(preferenceRules.workspaceId, workspaceId))
    .all();
  const byNormalized = new Map(live.map((row) => [normalizeRule(row.rule), row]));

  const rules: TracePreference[] = [];
  for (const line of content.split("\n")) {
    const match = /^- (Do|Avoid): (.+?)(?: \[[^\]]*\])?$/.exec(line.trim());
    if (!match) continue;
    const text = match[2]!.trim();
    const hit = byNormalized.get(normalizeRule(text));
    rules.push({
      ruleId: hit?.id ?? null,
      rule: text,
      polarity: match[1] === "Avoid" ? "avoid" : "do",
      confidence: hit?.confidence ?? null,
      href: `/workspaces/${workspaceId}/preferences`,
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

async function planFor(
  db: Db,
  workspaceId: string,
  campaignId: string | null,
  artifactText: string,
): Promise<TracePlan | null> {
  if (!campaignId) return null;
  const campaign = await db
    .select({ name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .get();
  if (!campaign) return null;
  const plan = (await getCurrentCampaignPlan(db, workspaceId, campaignId))?.plan;
  const pillars: string[] = plan?.pillars ?? [];
  // D-71.4: a wording match, not a recorded intent. The platform has never
  // stored which pillar a draft was written to serve, and inventing one would
  // put a fabricated fact inside the panel whose whole job is to be trusted.
  const ranked =
    pillars.length > 0 && artifactText.trim().length > 0
      ? rankTexts(
          artifactText,
          pillars.map((pillar, i) => ({ id: String(i), text: pillar })),
        )
      : [];
  const closest = ranked[0] ? (pillars[Number(ranked[0].id)] ?? null) : null;
  return {
    campaignId,
    campaignName: campaign.name,
    objective: plan?.objective ?? "",
    kpi: plan?.kpi ?? null,
    pillars,
    closestPillar: closest,
    href: `/workspaces/${workspaceId}/campaigns/${campaignId}`,
  };
}

async function originForDraft(
  db: Db,
  workspaceId: string,
  signalId: string | null,
): Promise<TraceOrigin | null> {
  if (!signalId) {
    return {
      kind: "manual",
      id: null,
      label: "Written on request",
      detail: null,
      href: null,
      at: null,
    };
  }
  const signal = await db
    .select({ content: signals.content, source: signals.source, createdAt: signals.createdAt })
    .from(signals)
    .where(and(eq(signals.workspaceId, workspaceId), eq(signals.id, signalId)))
    .get();
  if (!signal) {
    return {
      kind: "signal",
      id: signalId,
      label: "The triggering signal has since been deleted",
      detail: null,
      href: null,
      at: null,
    };
  }
  return {
    kind: "signal",
    id: signalId,
    label: `Signal from ${signal.source}`,
    detail: clip(signal.content),
    href: `/workspaces/${workspaceId}/discovery?signal=${signalId}`,
    at: signal.createdAt,
  };
}

interface RunFacts {
  runId: string | null;
  critic: TraceCritic | null;
  cost: TraceCost | null;
}

/**
 * Everything the engine recorded about the run that produced a draft: the
 * critique step's findings (with the citations Sprint 66 made mandatory) and
 * the metered cost. Absent for legacy-path drafts, which is not the same as
 * zero — see `costFromGeneration`.
 */
async function runFactsForDraft(db: Db, workspaceId: string, draftId: string): Promise<RunFacts> {
  const run = await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.draftId, draftId)))
    .orderBy(desc(pipelineRuns.createdAt))
    .get();
  if (!run) return { runId: null, critic: null, cost: null };

  const critiqueSteps = (await db
    .select()
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, run.id))
    .orderBy(pipelineRunSteps.createdAt)
    .all())
    .filter((step) => step.stepKey.includes("critique") && step.outputJson);

  let critic: TraceCritic | null = null;
  const last = critiqueSteps.at(-1);
  if (last?.outputJson) {
    const parsed = findingsOutputSchema.safeParse(JSON.parse(last.outputJson));
    if (parsed.success) {
      const output: FindingsOutput = parsed.data;
      critic = {
        score: output.score,
        findings: output.findings,
        iterations: critiqueSteps.length,
        source: "engine",
        href: `/workspaces/${workspaceId}/pipelines?run=${run.id}`,
      };
    }
  }

  const model = await db
    .select({ model: generations.model, provider: generations.provider })
    .from(generations)
    .where(eq(generations.id, run.generationId ?? ""))
    .get();

  return {
    runId: run.id,
    critic,
    cost: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costCents: run.costCents,
      model: model?.model ?? "engine",
      provider: model?.provider ?? "mixed",
      durationMs: null,
      estimated: false,
      href: `/workspaces/${workspaceId}/billing`,
    },
  };
}

/**
 * The legacy path never wrote a metered cost row, so we price the call from its
 * model and an estimated token count — and flag it, because a number the panel
 * presents as measured had better be measured (D-71.3).
 */
function costFromGeneration(
  workspaceId: string,
  row: { prompt: string; output: string; model: string; provider: string; durationMs: number },
): TraceCost {
  const usage = {
    inputTokens: estimateTokens(row.prompt),
    outputTokens: estimateTokens(row.output),
    cachedTokens: 0,
  };
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costCents: hasPricing(row.model) ? costCents(row.model, usage) : 0,
    model: row.model,
    provider: row.provider,
    durationMs: row.durationMs,
    estimated: true,
    href: `/workspaces/${workspaceId}/billing`,
  };
}

async function revisionsFor(db: Db, workspaceId: string, draftId: string): Promise<TraceRevision[]> {
  return (await db
    .select()
    .from(draftRevisionTurns)
    .where(
      and(eq(draftRevisionTurns.workspaceId, workspaceId), eq(draftRevisionTurns.draftId, draftId)),
    )
    .orderBy(draftRevisionTurns.createdAt)
    .limit(REVISION_LIMIT)
    .all())
    .map((turn) => ({
      id: turn.id,
      instruction: turn.instruction,
      status: turn.status,
      at: turn.createdAt,
      changedShare: turn.resultContent
        ? normalizedEditDistance(turn.sourceContent, turn.resultContent)
        : null,
      model: turn.model,
      provider: turn.provider,
    }));
}

function legacyCritic(workspaceId: string, reviewJson: string | null): TraceCritic | null {
  if (!reviewJson) return null;
  const parsed = generationReviewSchema.safeParse(JSON.parse(reviewJson));
  if (!parsed.success) return null;
  const review: GenerationReview = parsed.data;
  const findings = review.checks.flatMap((check) =>
    check.issues.map((issue) => ({
      issue,
      // The legacy reviewer predates required citations (Sprint 66); naming the
      // check is the most specific grounding that actually exists.
      citation: `${check.check.replaceAll("_", " ")} check`,
    })),
  );
  const scored = review.checks.map((check) => check.score).filter((s): s is number => s !== null);
  return {
    score: scored.length === 0 ? null : Math.round(scored.reduce((a, b) => a + b, 0) / scored.length),
    findings,
    iterations: 1,
    source: "legacy",
    href: `/workspaces/${workspaceId}/review`,
  };
}

// ---------------------------------------------------------------------------
// The four entry points
// ---------------------------------------------------------------------------

interface TraceCore {
  sections: ContextSection[];
  contextReason: string | null;
  meta: KnobResolveMeta;
  campaignId: string | null;
}

async function assemble(
  db: Db,
  workspaceId: string,
  subject: ArtifactTrace["subject"],
  core: TraceCore,
  parts: {
    origin: TraceOrigin | null;
    artifactText: string;
    critic: TraceCritic | null;
    revisions: TraceRevision[];
    cost: TraceCost | null;
  },
  now: number,
): Promise<ArtifactTrace> {
  const examplesSection = core.sections.find((s) => s.key === "examples" && s.included);
  const preferencesSection = core.sections.find((s) => s.key === "preferences" && s.included);
  return {
    subject,
    origin: parts.origin,
    plan: await planFor(db, workspaceId, core.campaignId, parts.artifactText),
    context: toTraceSections(workspaceId, core.sections, core.campaignId),
    contextReason: core.sections.length === 0 ? core.contextReason : null,
    examples: examplesSection ? parseExamplesSection(examplesSection.content) : [],
    preferences: preferencesSection
      ? await parsePreferencesSection(db, workspaceId, preferencesSection.content)
      : [],
    critic: parts.critic,
    revisions: parts.revisions,
    cost: parts.cost,
    knobs: await knobStatesForResolve(db, workspaceId, core.sections, core.meta),
    generatedAt: now,
  };
}

async function draftTrace(
  db: Db,
  workspaceId: string,
  draftId: string,
  subjectOverride: ArtifactTrace["subject"] | null,
  now: number,
): Promise<ArtifactTrace | undefined> {
  const draft = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .get();
  if (!draft) return undefined;

  const generation = draft.sourceGenerationId
    ? await db.select().from(generations).where(eq(generations.id, draft.sourceGenerationId)).get()
    : undefined;

  // The latest completed revision replaced the context the model saw, so it —
  // not the original generation — is the honest answer to "why did it write
  // this?" for the words currently on screen.
  const latestTurn = await db
    .select()
    .from(draftRevisionTurns)
    .where(
      and(
        eq(draftRevisionTurns.workspaceId, workspaceId),
        eq(draftRevisionTurns.draftId, draftId),
        eq(draftRevisionTurns.status, "completed"),
      ),
    )
    .orderBy(desc(draftRevisionTurns.createdAt))
    .get();

  const sections = latestTurn
    ? parseSections(latestTurn.sectionsJson)
    : parseSections(generation?.sectionsJson);

  const runFacts = await runFactsForDraft(db, workspaceId, draftId);
  const cost =
    runFacts.cost ??
    (generation
      ? costFromGeneration(workspaceId, {
          prompt: generation.prompt,
          output: generation.output,
          model: generation.model,
          provider: generation.provider,
          durationMs: generation.durationMs,
        })
      : null);

  return await assemble(
    db,
    workspaceId,
    subjectOverride ?? {
      kind: "draft",
      id: draft.id,
      title: title(draft.content),
      state: draft.state,
      href: `/workspaces/${workspaceId}/review?tab=approvals&draft=${draft.id}`,
      createdAt: draft.createdAt,
    },
    {
      sections,
      contextReason: generation
        ? "The resolved context for this draft was not stored."
        : "This draft was written outside the generation path, so no context was resolved.",
      meta: {
        taskType: draft.taskType as TaskType,
        channel: draft.channel as Channel,
        campaignId: draft.campaignId,
      },
      campaignId: draft.campaignId,
    },
    {
      origin: await originForDraft(db, workspaceId, draft.sourceSignalId),
      artifactText: draft.content,
      critic: runFacts.critic ?? legacyCritic(workspaceId, generation?.reviewJson ?? null),
      revisions: await revisionsFor(db, workspaceId, draftId),
      cost,
    },
    now,
  );
}

async function deliverableTrace(
  db: Db,
  workspaceId: string,
  deliverableId: string,
  now: number,
): Promise<ArtifactTrace | undefined> {
  const deliverable = await db
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.workspaceId, workspaceId), eq(deliverables.id, deliverableId)))
    .get();
  if (!deliverable) return undefined;

  const variant = await db
    .select()
    .from(variants)
    .where(eq(variants.deliverableId, deliverableId))
    .orderBy(desc(variants.variantVersion))
    .get();
  const snapshot = variant
    ? await db.select().from(contextSnapshots).where(eq(contextSnapshots.id, variant.contextSnapshotId)).get()
    : undefined;

  let sections: ContextSection[] = [];
  if (snapshot) {
    try {
      const resolved = JSON.parse(snapshot.resolvedContextJson) as { sections?: ContextSection[] };
      sections = Array.isArray(resolved.sections) ? resolved.sections : [];
    } catch {
      sections = [];
    }
  }

  const pkg = deliverable.packageId
    ? await db
        .select({ angle: contentPackages.angle, createdAt: contentPackages.createdAt })
        .from(contentPackages)
        .where(eq(contentPackages.id, deliverable.packageId))
        .get()
    : undefined;

  const origin: TraceOrigin = pkg
    ? {
        kind: "package",
        id: deliverable.packageId,
        label: `Content package: ${clip(pkg.angle, 80)}`,
        detail: deliverable.angle || null,
        href: `/workspaces/${workspaceId}/packages?package=${deliverable.packageId}`,
        at: pkg.createdAt,
      }
    : {
        kind: "manual",
        id: null,
        label: "A planned slot on the campaign calendar",
        detail: deliverable.angle || null,
        href: `/workspaces/${workspaceId}/campaigns/${deliverable.campaignId}`,
        at: deliverable.createdAt,
      };

  return await assemble(
    db,
    workspaceId,
    {
      kind: "deliverable",
      id: deliverable.id,
      title: variant ? title(variant.content) : deliverable.angle || "Planned deliverable",
      state: deliverable.status,
      href: `/workspaces/${workspaceId}/deliverables?deliverable=${deliverable.id}`,
      createdAt: deliverable.createdAt,
    },
    {
      sections,
      contextReason: variant
        ? "The context snapshot behind this variant is missing."
        : "Nothing has been generated for this deliverable yet.",
      meta: { campaignId: deliverable.campaignId },
      campaignId: deliverable.campaignId,
    },
    {
      origin,
      artifactText: variant?.content ?? deliverable.angle,
      critic: null,
      revisions: [],
      cost:
        variant && snapshot
          ? {
              inputTokens: estimateTokens(
                sections.map((section) => section.content).join("\n"),
              ),
              outputTokens: estimateTokens(variant.content),
              costCents: hasPricing(variant.model)
                ? costCents(variant.model, {
                    inputTokens: estimateTokens(
                      sections.map((section) => section.content).join("\n"),
                    ),
                    outputTokens: estimateTokens(variant.content),
                    cachedTokens: 0,
                  })
                : 0,
              model: variant.model,
              provider: variant.provider,
              durationMs: variant.durationMs,
              estimated: true,
              href: `/workspaces/${workspaceId}/billing`,
            }
          : null,
    },
    now,
  );
}

async function publicationTrace(
  db: Db,
  workspaceId: string,
  publicationId: string,
  now: number,
): Promise<ArtifactTrace | undefined> {
  const publication = await db
    .select()
    .from(publications)
    .where(and(eq(publications.workspaceId, workspaceId), eq(publications.id, publicationId)))
    .get();
  if (!publication) return undefined;
  return await draftTrace(db, workspaceId, publication.draftId, {
    kind: "publication",
    id: publication.id,
    title: publication.title,
    state: publication.status,
    href: `/workspaces/${workspaceId}/content?publication=${publication.id}`,
    createdAt: publication.scheduledFor,
  }, now);
}

async function externalActionTrace(
  db: Db,
  workspaceId: string,
  actionId: string,
  now: number,
): Promise<ArtifactTrace | undefined> {
  const action = await db
    .select()
    .from(externalActions)
    .where(and(eq(externalActions.workspaceId, workspaceId), eq(externalActions.id, actionId)))
    .get();
  if (!action) return undefined;

  const subject: ArtifactTrace["subject"] = {
    kind: "external_action",
    id: action.id,
    title: action.kind.replaceAll("_", " "),
    state: action.status,
    href: `/workspaces/${workspaceId}/review?tab=authorizations&action=${action.id}`,
    createdAt: action.createdAt,
  };

  if (action.draftId) {
    const traced = await draftTrace(db, workspaceId, action.draftId, subject, now);
    if (traced) return traced;
  }

  // D-71.9: a budget or targeting change was never generated, so there is no
  // resolve to show. The panel names the gap rather than rendering blank.
  return await assemble(
    db,
    workspaceId,
    subject,
    {
      sections: [],
      contextReason:
        "This action was assembled from your settings, not written by a model — there is no prompt behind it.",
      meta: { campaignId: action.campaignId },
      campaignId: action.campaignId,
    },
    {
      origin: {
        kind: "manual",
        id: action.proposedByUserId,
        label: `Proposed by ${action.proposedByLabel}`,
        detail: null,
        href: null,
        at: action.createdAt,
      },
      artifactText: "",
      critic: null,
      revisions: [],
      cost: null,
    },
    now,
  );
}

/** The one entry point. Returns undefined when the subject does not exist. */
export async function buildArtifactTrace(
  db: Db,
  workspaceId: string,
  kind: TraceSubjectKind,
  id: string,
  now = Date.now(),
): Promise<ArtifactTrace | undefined> {
  switch (kind) {
    case "draft":
      return await draftTrace(db, workspaceId, id, null, now);
    case "deliverable":
      return await deliverableTrace(db, workspaceId, id, now);
    case "publication":
      return await publicationTrace(db, workspaceId, id, now);
    case "external_action":
      return await externalActionTrace(db, workspaceId, id, now);
  }
}
