import type { AgentToolName, ChatCitation } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Tool call → citations (Sprint 76, D-76.8).
//
// The PRD makes citations mandatory: "any factual claim sourced from evidence,
// metrics, or records renders with a link to the record". The registry's tools
// are shared with pipelines and the critic, neither of which wants a citation
// envelope wrapped around its output — so the mapping lives here, keyed by tool
// name, instead of changing what the tools return.
//
// A citation must be able to become a LINK. Sprint 76 shipped two tools that
// could produce none — `find_similar_approved_drafts` and
// `find_instructive_rejections` returned prior text with no record id — and
// Sprint 78 fixed that at the source: both now return the `draftId` the example
// came from, which they already had in hand. What remains uncitable is the
// honest remainder: an example drawn from a *rated generation* is not a draft
// and has no page to open, so it carries `draftId: null` and is skipped
// explicitly rather than by omission.
//
// Everything below reads plain JSON defensively. A tool whose shape drifts
// produces fewer citations, never a thrown turn.
// ---------------------------------------------------------------------------

const LABEL_MAX = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function label(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= LABEL_MAX ? clean : `${clean.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

function optionalDetail(value: string | null): { detail?: string } {
  return value ? { detail: value } : {};
}

/**
 * Citations for one tool call. Takes the call's ARGUMENTS as well as its
 * result: a couple of tools identify their subject only in the request (the
 * guardrails read is scoped by a channel it does not echo back; the funnel
 * returns counts, not the sequence id), and a citation with no ref cannot be
 * rendered as a link.
 *
 * `data` citations use a `<kind>:<id>` ref so the web layer routes a chip to
 * the right page without this module knowing any URLs.
 */
export function citationsForToolCall(
  toolName: AgentToolName | string,
  args: unknown,
  result: unknown,
): ChatCitation[] {
  if (!isRecord(result)) return [];
  const input = isRecord(args) ? args : {};
  const out: ChatCitation[] = [];

  switch (toolName) {
    case "search_evidence": {
      for (const raw of arr(result.results)) {
        if (!isRecord(raw)) continue;
        const ref = str(raw.documentId);
        if (!ref) continue;
        const score = num(raw.score);
        out.push({
          kind: "evidence",
          ref,
          label: label(str(raw.title) ?? "Evidence document"),
          ...optionalDetail(score === null ? null : `relevance ${score.toFixed(2)}`),
        });
      }
      break;
    }

    case "get_brain_section": {
      // Two shapes: an exact lookup returns one section inline, a query returns
      // a `sections` array. Both are keyed the same way.
      const sections = arr(result.sections);
      const rows = sections.length > 0 ? sections : [result];
      for (const raw of rows) {
        if (!isRecord(raw)) continue;
        const docType = str(raw.docType);
        const sectionId = str(raw.sectionId);
        if (!docType || !sectionId) continue;
        out.push({
          kind: "brain",
          ref: `${docType}#${sectionId}`,
          label: label(str(raw.heading) ?? sectionId),
          detail: docType,
        });
      }
      break;
    }

    case "get_campaign_plan":
    case "get_campaign_insights": {
      const campaign = isRecord(result.campaign) ? result.campaign : null;
      const id = campaign ? str(campaign.id) : null;
      if (id) {
        out.push({
          kind: "data",
          ref: `campaign:${id}`,
          label: label(str(campaign?.name) ?? "Campaign"),
          detail: toolName === "get_campaign_plan" ? "plan" : "performance",
        });
      }
      break;
    }

    case "list_campaigns": {
      for (const raw of arr(result.campaigns)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push({
          kind: "data",
          ref: `campaign:${id}`,
          label: label(str(raw.name) ?? "Campaign"),
          ...optionalDetail(str(raw.status)),
        });
      }
      break;
    }

    case "list_personas": {
      for (const raw of arr(result.personas)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push({ kind: "data", ref: `persona:${id}`, label: label(str(raw.name) ?? "Persona") });
      }
      break;
    }

    case "get_persona": {
      const id = str(result.id);
      if (id) {
        out.push({
          kind: "data",
          ref: `persona:${id}`,
          label: label(str(result.name) ?? "Persona"),
        });
      }
      break;
    }

    // Both return publication records: `publications` from the metrics tool,
    // `posts` from the topic search.
    case "list_recent_publications_with_metrics":
    case "get_prior_posts_on_topic": {
      for (const raw of arr(result.publications ?? result.posts)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push({
          kind: "data",
          ref: `publication:${id}`,
          label: label(str(raw.title) ?? "Publication"),
          ...optionalDetail(str(raw.channel)),
        });
      }
      break;
    }

    case "search_discovery_items": {
      for (const raw of arr(result.items)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push({
          kind: "data",
          ref: `discovery_item:${id}`,
          label: label(str(raw.title) ?? "Discovery item"),
          ...optionalDetail(str(raw.status)),
        });
      }
      break;
    }

    case "get_metric_summary": {
      // The subject is the record; the window is what makes the number mean
      // anything, so it rides along rather than being dropped.
      const subjectType = str(result.subjectType);
      const window = str(result.window);
      if (subjectType && window) {
        const subjectId = str(result.subjectId);
        out.push({
          kind: "data",
          ref: subjectId ? `${subjectType}:${subjectId}` : `metrics:${subjectType}`,
          label: label(`${subjectType} metrics (${window})`),
          detail: str(result.windowKind) ?? window,
        });
      }
      break;
    }

    case "get_sequence_funnel": {
      // The funnel returns counts; only the request names the sequence.
      if (str(result.error)) break;
      const id = str(input.sequenceId);
      if (id) {
        out.push({
          kind: "data",
          ref: `outreach_sequence:${id}`,
          label: label(str(result.sequenceName) ?? str(result.name) ?? "Outreach sequence"),
          detail: "funnel",
        });
      }
      break;
    }

    case "get_workspace_insights": {
      out.push({
        kind: "data",
        ref: "workspace:insights",
        label: "Workspace performance rollup",
        detail: "all campaigns and channels",
      });
      break;
    }

    case "list_channel_guardrails": {
      const channel = str(input.channel);
      if (channel) {
        out.push({
          kind: "data",
          ref: `guidance:${channel}`,
          label: label(`${channel} guidance`),
          detail: "channel guardrails",
        });
      }
      break;
    }

    case "safe_fetch_url": {
      const url = str(result.finalUrl) ?? str(input.url);
      // An error result names no page worth citing.
      if (url && !str(result.error)) {
        out.push({
          kind: "data",
          ref: url,
          label: label(url),
          // Marked at the citation, because a fetched page is the one source in
          // this set that the workspace does not control.
          detail: "fetched web page",
        });
      }
      break;
    }

    // Both return prior human decisions about the workspace's own content, and
    // both key them on the draft the decision was made about (Sprint 78).
    case "find_similar_approved_drafts":
    case "find_instructive_rejections": {
      const approved = toolName === "find_similar_approved_drafts";
      for (const raw of arr(approved ? result.drafts : result.rejections)) {
        if (!isRecord(raw)) continue;
        // Null for a rated generation — real, and not a draft anyone can open.
        const id = str(raw.draftId);
        if (!id) continue;
        const outcome = str(raw.outcome);
        out.push({
          kind: "data",
          ref: `draft:${id}`,
          label: label(str(raw.content) ?? (approved ? "Approved draft" : "Corrected draft")),
          detail: approved
            ? raw.wasEdited === true
              ? "approved after edits"
              : "approved"
            : (outcome ?? "corrected"),
        });
      }
      break;
    }

    default:
      break;
  }

  return out;
}

/** Union of a turn's citations; first occurrence wins on `kind:ref`. */
export function dedupeCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
