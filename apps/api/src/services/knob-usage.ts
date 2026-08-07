// Sprint 71 (PRD §8, direction move 7b): the nine context-customization knobs,
// evaluated against one real resolve — and aggregated across many so that
// atlas conflict #4 ("knob sprawl") can be settled with data.
//
// Two entry points, one rule set:
//   knobStatesForResolve  — what each knob did to THIS bundle
//   buildKnobUsageReport  — what each knob has done across the last N bundles
//
// Leaf module by design (drizzle + contracts + brain types only, no agent or
// route imports), per the Sprint 65 import-cycle lesson.
//
// D-71.5: state is derived from the persisted bundle, never asserted by the
// caller. A knob that claims to be applied while contributing nothing is
// precisely the knob the follow-up sprint should delete, and only the bundle
// can prove it.
//
// D-71.6: this file adds no table and no counter. The knob tables already hold
// the whole configuration history and `generations.sections_json` already holds
// the whole application history; the report is a read.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  CONTEXT_KNOBS,
  KNOB_USAGE_SAMPLE_LIMIT,
  type Channel,
  type ContextKnobKey,
  type KnobUsage,
  type KnobUsageReport,
  type TaskType,
  type TraceKnob,
  type TraceKnobState,
} from "@tuezday/contracts";
import type { ContextSection } from "@tuezday/brain";
import type { Db } from "../db";
import {
  brainDocuments,
  contextMatrixOverrides,
  designOverlays,
  generationSettings,
  generations,
  guidanceOverrides,
} from "../db/schema";

/** What we know about the resolve a bundle came from. Every field optional: an
 *  old generation row may not carry all of it, and the report must still run. */
export interface KnobResolveMeta {
  taskType?: TaskType | null;
  channel?: Channel | null;
  campaignId?: string | null;
}

// ---------------------------------------------------------------------------
// Reading the bundle
// ---------------------------------------------------------------------------

// Three knobs leave no structured mark on a section — only the resolver's own
// written reason. Those strings are stable in `packages/brain/src/resolver.ts`
// and are already persisted in every historical trace, which is exactly why we
// read them rather than adding a field only new rows would have.
const WORKSPACE_GUIDANCE_MARK = "workspace override";
const BUILTIN_GUIDANCE_MARK = "built-in default";
const SCOPED_GUIDANCE_MARK = ", scoped: ";
const MATRIX_OVERRIDE_MARK = "task matrix — workspace override";

function channelSection(sections: ContextSection[]): ContextSection | undefined {
  return sections.find((section) => section.key === "channel");
}

function included(sections: ContextSection[], predicate: (s: ContextSection) => boolean): boolean {
  return sections.some((section) => section.included && predicate(section));
}

/**
 * Did a workspace matrix override actually shape this bundle?
 *
 * Read from the resolver's own reason, which carries `— workspace override`
 * exactly when the winning matrix cell came from this workspace. Comparing the
 * section's effective `mode` against the shipped default looks more rigorous
 * and is wrong: the resolver legitimately promotes an outline to full when
 * there is budget headroom, so a default-matrix resolve routinely ends up with
 * a mode the default matrix did not ask for.
 */
function matrixApplied(sections: ContextSection[]): boolean {
  return sections.some((section) => section.reason.includes(MATRIX_OVERRIDE_MARK));
}

// ---------------------------------------------------------------------------
// Reading the knob tables
// ---------------------------------------------------------------------------

interface ConfigCount {
  count: number;
  lastAt: number | null;
}

const NOTHING: ConfigCount = { count: 0, lastAt: null };

export interface KnobConfiguration {
  brainDocsWritten: ConfigCount;
  workspaceGuidance: ConfigCount;
  scopedGuidance: ConfigCount;
  matrixOverrides: ConfigCount;
  generationSettings: ConfigCount;
  designOverlays: ConfigCount;
}

/**
 * One read of every knob table. Hoisted out of the per-resolve path so the
 * report can replay 200 bundles without re-querying six tables 200 times.
 */
export function readKnobConfiguration(db: Db, workspaceId: string): KnobConfiguration {
  const written = db
    .select({
      count: sql<number>`count(*)`,
      lastAt: sql<number | null>`max(${brainDocuments.updatedAt})`,
    })
    .from(brainDocuments)
    .where(
      and(
        eq(brainDocuments.workspaceId, workspaceId),
        sql`trim(${brainDocuments.content}) <> ''`,
      ),
    )
    .get();

  const guidance = db
    .select({
      scoped: guidanceOverrides.personaId,
      campaignId: guidanceOverrides.campaignId,
      updatedAt: guidanceOverrides.updatedAt,
    })
    .from(guidanceOverrides)
    .where(eq(guidanceOverrides.workspaceId, workspaceId))
    .all();
  const unscoped = guidance.filter((row) => !row.scoped && !row.campaignId);
  const scoped = guidance.filter((row) => row.scoped || row.campaignId);

  const matrix = db
    .select({
      count: sql<number>`count(*)`,
      lastAt: sql<number | null>`max(${contextMatrixOverrides.updatedAt})`,
    })
    .from(contextMatrixOverrides)
    .where(eq(contextMatrixOverrides.workspaceId, workspaceId))
    .get();

  const settings = db
    .select()
    .from(generationSettings)
    .where(eq(generationSettings.workspaceId, workspaceId))
    .get();
  // A row that matches the shipped defaults is not a knob anybody turned.
  const settingsTouched =
    settings !== undefined &&
    (settings.reviewEnabled !== 1 ||
      settings.angleEnabled !== 0 ||
      settings.angleCount !== 3 ||
      settings.flagThreshold !== 70);

  const overlays = db
    .select({
      count: sql<number>`count(*)`,
      lastAt: sql<number | null>`max(${designOverlays.updatedAt})`,
    })
    .from(designOverlays)
    .where(eq(designOverlays.workspaceId, workspaceId))
    .get();

  const latest = (rows: { updatedAt: number }[]): number | null =>
    rows.length === 0 ? null : Math.max(...rows.map((row) => row.updatedAt));

  return {
    brainDocsWritten: { count: written?.count ?? 0, lastAt: written?.lastAt ?? null },
    workspaceGuidance: { count: unscoped.length, lastAt: latest(unscoped) },
    scopedGuidance: { count: scoped.length, lastAt: latest(scoped) },
    matrixOverrides: { count: matrix?.count ?? 0, lastAt: matrix?.lastAt ?? null },
    generationSettings: settingsTouched
      ? { count: 1, lastAt: settings!.updatedAt }
      : NOTHING,
    designOverlays: { count: overlays?.count ?? 0, lastAt: overlays?.lastAt ?? null },
  };
}

// ---------------------------------------------------------------------------
// Per-knob verdicts
// ---------------------------------------------------------------------------

interface Verdict {
  applied: boolean;
  /** What to say when it applied. */
  appliedDetail: string;
  /** What to say when it is set but did not touch this bundle. */
  configuredDetail: string;
  /** What to say when there is nothing to say. */
  absentDetail: string;
  config: ConfigCount;
}

function verdicts(
  sections: ContextSection[],
  meta: KnobResolveMeta,
  config: KnobConfiguration,
): Record<ContextKnobKey, Verdict> {
  const channel = channelSection(sections);
  const orgSections = sections.filter((s) => s.layer === "org" && s.included);
  const zoomSections = sections.filter((s) => s.key.startsWith("zoom:") && s.included);
  const campaignApplied = included(sections, (s) => s.layer === "campaign" || s.layer === "plan");
  const scopedApplied = channel?.reason.includes(SCOPED_GUIDANCE_MARK) === true;
  const workspaceGuidanceApplied =
    channel?.reason.includes(WORKSPACE_GUIDANCE_MARK) === true && !scopedApplied;
  const builtinApplied = channel?.reason.includes(BUILTIN_GUIDANCE_MARK) === true;
  // Generation settings never render a section of their own; they decide
  // whether an angle was picked first and whether a pre-review ran, and both
  // of those leave a section behind.
  const settingsApplied = included(sections, (s) => s.layer === "angle" || s.layer === "review");
  const overlayForChannel = config.designOverlays.count > 0;

  return {
    brain_docs: {
      applied: orgSections.length > 0,
      appliedDetail: `${orgSections.length} of your five brain documents entered this prompt.`,
      configuredDetail:
        "Your brain documents are written but the task matrix omitted all of them here.",
      absentDetail: "No brain document has been written yet.",
      config: config.brainDocsWritten,
    },
    channel_guidance_builtin: {
      applied: builtinApplied,
      appliedDetail: meta.channel
        ? `The shipped guidance for ${meta.channel} was used as-is.`
        : "The shipped channel guidance was used as-is.",
      configuredDetail: "Always available, but your own guidance took precedence here.",
      absentDetail: "Always available, but your own guidance took precedence here.",
      // Built-in guidance ships with the platform: there is nothing to count.
      config: { count: 0, lastAt: null },
    },
    channel_guidance_workspace: {
      applied: workspaceGuidanceApplied,
      appliedDetail: "Your workspace guidance replaced the built-in for this channel.",
      configuredDetail: "You have channel guidance, but not for this channel.",
      absentDetail: "You have not overridden the built-in guidance on any channel.",
      config: config.workspaceGuidance,
    },
    scoped_guidance: {
      applied: scopedApplied,
      appliedDetail:
        channel?.reason.split(SCOPED_GUIDANCE_MARK)[1]?.replace(/\)\.$/, "").trim() ??
        "A persona- or campaign-scoped override won most-specific-wins.",
      configuredDetail: "You have scoped guidance, but none matched this persona or campaign.",
      absentDetail: "No persona or campaign writes differently on any channel.",
      config: config.scopedGuidance,
    },
    context_matrix: {
      applied: matrixApplied(sections),
      appliedDetail: "Your matrix changed how a brain document entered this task.",
      configuredDetail: "You have matrix overrides, but none applied to this task type.",
      absentDetail: "Every brain document enters on the shipped defaults.",
      config: config.matrixOverrides,
    },
    generation_settings: {
      applied: settingsApplied,
      appliedDetail: "An angle step or a pre-review ran because of your settings.",
      configuredDetail: "Your settings differ from the defaults but changed nothing here.",
      absentDetail: "Running on the default generation settings.",
      config: config.generationSettings,
    },
    campaign_overlay: {
      applied: campaignApplied,
      appliedDetail: "A campaign overlay and/or its plan entered this prompt.",
      configuredDetail: "This artifact belongs to no campaign.",
      absentDetail: "This artifact belongs to no campaign.",
      config: meta.campaignId ? { count: 1, lastAt: null } : NOTHING,
    },
    zoom: {
      applied: zoomSections.length > 0,
      appliedDetail: `${zoomSections.length} brain section${
        zoomSections.length === 1 ? " was" : "s were"
      } pulled in full by lexical (BM25) ranking.`,
      configuredDetail: "Zoom ran but no section matched the query.",
      absentDetail: "Zoom did not run for this bundle.",
      // Zoom has no settings: it is on whenever a doc enters as an outline.
      config: { count: 0, lastAt: null },
    },
    design_overlays: {
      // Design overlays govern rendered artwork, never the text bundle, so
      // there is nothing in `sections` to find. Configured-for-this-channel is
      // the strongest honest claim.
      applied: false,
      appliedDetail: "",
      configuredDetail: overlayForChannel
        ? "You have design overlays; they shape rendered artwork, not this text."
        : "",
      absentDetail: "No design overlay has been written.",
      config: config.designOverlays,
    },
  };
}

/** The nine knobs, in precedence order, for one persisted bundle. */
export function knobStatesForResolve(
  db: Db,
  workspaceId: string,
  sections: ContextSection[],
  meta: KnobResolveMeta = {},
  config?: KnobConfiguration,
): TraceKnob[] {
  const resolved = config ?? readKnobConfiguration(db, workspaceId);
  const table = verdicts(sections, meta, resolved);
  return CONTEXT_KNOBS.map((knob) => {
    const verdict = table[knob.key];
    const state: TraceKnobState = verdict.applied
      ? "applied"
      : verdict.config.count > 0
        ? "configured"
        : "absent";
    const detail =
      state === "applied"
        ? verdict.appliedDetail
        : state === "configured"
          ? verdict.configuredDetail
          : verdict.absentDetail;
    return {
      key: knob.key,
      label: knob.label,
      question: knob.question,
      state,
      detail,
      href: `/workspaces/${workspaceId}${knob.surface}`,
    };
  });
}

// ---------------------------------------------------------------------------
// The aggregate — the deletion-decision dataset
// ---------------------------------------------------------------------------

export interface KnobUsageOptions {
  /** How many recent resolves to replay. Bounded, and the bound is reported. */
  sampleLimit?: number;
  now?: number;
}

/**
 * Which knobs this workspace actually sets, and how often each one demonstrably
 * changed a prompt. `appliedShare` is over `sampledResolves`, never implied
 * over all history (D-71.7).
 */
export function buildKnobUsageReport(
  db: Db,
  workspaceId: string,
  options: KnobUsageOptions = {},
): KnobUsageReport {
  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? KNOB_USAGE_SAMPLE_LIMIT, 1_000));
  const config = readKnobConfiguration(db, workspaceId);

  const rows = db
    .select({
      sectionsJson: generations.sectionsJson,
      taskType: generations.taskType,
      channel: generations.channel,
      campaignId: generations.campaignId,
    })
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .orderBy(desc(generations.createdAt))
    .limit(sampleLimit)
    .all();

  const appliedCounts = new Map<ContextKnobKey, number>();
  let sampled = 0;
  for (const row of rows) {
    let sections: ContextSection[];
    try {
      sections = JSON.parse(row.sectionsJson) as ContextSection[];
    } catch {
      // A malformed trace is a trace we cannot judge; skipping it keeps the
      // denominator honest rather than counting it as "knob not applied".
      continue;
    }
    if (!Array.isArray(sections) || sections.length === 0) continue;
    sampled += 1;
    const states = knobStatesForResolve(
      db,
      workspaceId,
      sections,
      {
        taskType: row.taskType as TaskType,
        channel: row.channel as Channel,
        campaignId: row.campaignId,
      },
      config,
    );
    for (const knob of states) {
      if (knob.state === "applied") {
        appliedCounts.set(knob.key, (appliedCounts.get(knob.key) ?? 0) + 1);
      }
    }
  }

  const configOf: Record<ContextKnobKey, ConfigCount> = {
    brain_docs: config.brainDocsWritten,
    channel_guidance_builtin: { count: 0, lastAt: null },
    channel_guidance_workspace: config.workspaceGuidance,
    scoped_guidance: config.scopedGuidance,
    context_matrix: config.matrixOverrides,
    generation_settings: config.generationSettings,
    campaign_overlay: NOTHING,
    zoom: { count: 0, lastAt: null },
    design_overlays: config.designOverlays,
  };

  const knobs: KnobUsage[] = CONTEXT_KNOBS.map((knob) => {
    const applied = appliedCounts.get(knob.key) ?? 0;
    const entry = configOf[knob.key];
    return {
      key: knob.key,
      label: knob.label,
      question: knob.question,
      href: `/workspaces/${workspaceId}${knob.surface}`,
      // The two always-on knobs are never "configured"; they are configured by
      // shipping. Counting them as unconfigured would read as unused.
      configured: entry.count > 0 || knob.key === "channel_guidance_builtin" || knob.key === "zoom",
      configuredCount: entry.count,
      lastConfiguredAt: entry.lastAt,
      appliedResolves: applied,
      appliedShare: sampled === 0 ? 0 : applied / sampled,
    };
  });

  return {
    knobs,
    sampledResolves: sampled,
    sampleLimit,
    generatedAt: options.now ?? Date.now(),
  };
}
