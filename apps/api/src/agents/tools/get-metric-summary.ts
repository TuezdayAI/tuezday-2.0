import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { summarizeMetrics } from "../../services/metrics";
import type { Tool } from "../registry";

const input = toolInputSchemas.get_metric_summary;
type Input = z.infer<typeof input>;

/**
 * A windowed rollup over the Sprint 55 fact table. `window` is a required
 * argument rather than a defaulted one on purpose: cumulative ("24h"/"7d",
 * running totals per subject) and periodic ("1d", per-day totals) answer
 * different questions and must never be summed together, so the model has to
 * say which it is asking. Every result carries the interpretation back.
 */
export const getMetricSummaryTool: Tool<Input, unknown> = {
  name: "get_metric_summary",
  description:
    "Roll up observed metrics (impressions, clicks, likes, comments, shares, engagements, conversions, spend) for a subject type. window is required: use '1d' to compare date ranges (per-day totals, summed over the range), '24h' or '7d' for lifetime-to-date totals per subject, 'point' for manual snapshot readings. Omit subjectId to roll up across every subject of that type; use sinceDays to bound how far back observations count.",
  input,
  access: "read",
  async run(ctx, { subjectType, subjectId, metricKeys, window, sinceDays }) {
    const summary = await summarizeMetrics(ctx.db, ctx.workspaceId, {
      subjectType,
      ...(subjectId ? { subjectId } : {}),
      ...(metricKeys ? { metricKeys } : {}),
      window,
      ...(sinceDays === undefined ? {} : { sinceDays }),
    });
    if (summary.entries.length === 0) {
      return {
        ...summary,
        note: `No ${window} metrics recorded for ${subjectType}${subjectId ? ` ${subjectId}` : ""}${
          sinceDays ? ` in the last ${sinceDays} days` : ""
        }. Absence of a reading is not a zero — the platform may simply not have observed this yet.`,
      };
    }
    return summary;
  },
};
