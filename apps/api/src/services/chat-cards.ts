import {
  CHAT_CARDS_PER_TURN,
  CHAT_CARD_BODY_MAX_CHARS,
  TOOL_CARD_KINDS,
  type AgentToolName,
  type ChatCard,
  type ChatCardAction,
  type ChatCardKind,
} from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Tool call → typed result cards (Sprint 77, D-77.1).
//
// The sibling of `chat-citations.ts`, and deliberately shaped like it: keyed by
// tool name, reading plain JSON defensively, producing fewer cards rather than
// a thrown turn when a tool's shape drifts.
//
// A citation says "this claim came from that record". A card IS the record —
// rendered, and actionable where a route for the action already exists. Which
// tools produce which kind is declared once in `TOOL_CARD_KINDS`, so the map
// and this file cannot silently disagree: a test asserts every key here has a
// hint and every hint has a case.
//
// Computed server-side rather than in the browser, because tool results are
// large, they are the one place untrusted content lives, and a second
// interpreter in React would drift from this one within a sprint.
// ---------------------------------------------------------------------------

const TITLE_MAX = 120;

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

function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function title(text: string): string {
  return clamp(text, TITLE_MAX);
}

function body(text: string | null): string | null {
  return text ? clamp(text, CHAT_CARD_BODY_MAX_CHARS) : null;
}

type Field = { label: string; value: string };

/** Fields with no value are omitted, not rendered as an em dash. */
function fields(...pairs: [string, string | number | null | undefined][]): Field[] {
  const out: Field[] = [];
  for (const [label, value] of pairs) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "number" ? String(value) : value.trim();
    if (!text) continue;
    out.push({ label, value: text });
  }
  return out;
}

function card(
  kind: ChatCardKind,
  ref: string,
  parts: {
    title: string;
    subtitle?: string | null;
    fields?: Field[];
    body?: string | null;
    actions?: ChatCardAction[];
  },
): ChatCard {
  return {
    kind,
    ref,
    title: title(parts.title),
    subtitle: parts.subtitle ? clamp(parts.subtitle, TITLE_MAX) : null,
    fields: parts.fields ?? [],
    body: parts.body ?? null,
    // Every card can be opened; that is what the `<kind>:<id>` ref is for.
    actions: parts.actions ?? ["open"],
  };
}

/**
 * A draft's actions are its state (D-77.3). Approve on an already-approved
 * draft is a button that produces a 409, and a button that cannot work is
 * worse than no button — it teaches the founder the cards are decorative.
 */
function draftActions(state: string | null): ChatCardAction[] {
  return state === "pending_review"
    ? ["open", "approve", "reject", "edit"]
    : ["open"];
}

function metricFields(source: Record<string, unknown>): Field[] {
  const out: Field[] = [];
  const metrics = source.metrics;
  if (isRecord(metrics)) {
    for (const [key, value] of Object.entries(metrics)) {
      const n = num(value);
      if (n === null) continue;
      out.push({ label: key.replace(/_/g, " "), value: String(n) });
      if (out.length >= 6) break;
    }
  }
  return out;
}

/**
 * Cards for one tool call. Takes the arguments as well as the result for the
 * same reason the citation mapper does: a couple of tools name their subject
 * only in the request.
 */
export function cardsForToolCall(
  toolName: AgentToolName | string,
  args: unknown,
  result: unknown,
): ChatCard[] {
  if (!isRecord(result)) return [];
  // An error result describes a failure, not a record worth rendering.
  if (str(result.error)) return [];
  const input = isRecord(args) ? args : {};
  const out: ChatCard[] = [];

  switch (toolName) {
    case "list_campaigns": {
      for (const raw of arr(result.campaigns)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push(
          card("campaign", `campaign:${id}`, {
            title: str(raw.name) ?? "Campaign",
            subtitle: str(raw.status),
            fields: fields(
              ["Objective", str(raw.objective)],
              ["KPI", str(raw.kpi)],
              ["Timeframe", str(raw.timeframe)],
              ["Channels", arr(raw.channels).filter((c) => typeof c === "string").join(", ")],
            ),
          }),
        );
      }
      break;
    }

    case "get_campaign_plan":
    case "get_campaign_insights": {
      const campaign = isRecord(result.campaign) ? result.campaign : null;
      const id = campaign ? str(campaign.id) : null;
      if (!id) break;
      out.push(
        card("campaign", `campaign:${id}`, {
          title: str(campaign?.name) ?? "Campaign",
          subtitle: toolName === "get_campaign_plan" ? "plan" : "performance",
          fields: fields(
            ["Status", str(campaign?.status)],
            ["Objective", str(campaign?.objective)],
            ["KPI", str(campaign?.kpi)],
            ...(metricFields(result).map((f) => [f.label, f.value] as [string, string])),
          ),
        }),
      );
      break;
    }

    // Three tools return draft-shaped rows under three different keys. Only
    // `list_drafts` returns a live `state`, so only its cards can act.
    case "list_drafts":
    case "find_similar_approved_drafts":
    case "find_instructive_rejections": {
      const key =
        toolName === "list_drafts"
          ? "drafts"
          : toolName === "find_similar_approved_drafts"
            ? "drafts"
            : "rejections";
      for (const raw of arr(result[key])) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id) ?? str(raw.draftId);
        // Null for a training example drawn from a rated generation — real,
        // and not a draft anyone can open (Sprint 78's honest remainder).
        if (!id) continue;
        const state = str(raw.state);
        const content = str(raw.content);
        out.push(
          card("draft", `draft:${id}`, {
            title: content ? clamp(content, 60) : "Draft",
            subtitle:
              state ??
              str(raw.outcome) ??
              (raw.wasEdited === true ? "approved after edits" : "approved"),
            fields: fields(["Channel", str(raw.channel)], ["Type", str(raw.taskType)]),
            body: body(content),
            actions: draftActions(state),
          }),
        );
      }
      break;
    }

    case "list_recent_publications_with_metrics":
    case "get_prior_posts_on_topic": {
      for (const raw of arr(result.publications ?? result.posts)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push(
          card("publication", `publication:${id}`, {
            title: str(raw.title) ?? "Publication",
            subtitle: str(raw.channel),
            fields: fields(
              ["Status", str(raw.status)],
              ...(metricFields(raw).map((f) => [f.label, f.value] as [string, string])),
            ),
            body: body(str(raw.content) ?? str(raw.excerpt)),
          }),
        );
      }
      break;
    }

    case "list_personas": {
      for (const raw of arr(result.personas)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push(
          card("persona", `persona:${id}`, {
            title: str(raw.name) ?? "Persona",
            subtitle: str(raw.tone),
            fields: fields(["Role", str(raw.role)], ["Audience", str(raw.audience)]),
          }),
        );
      }
      break;
    }

    case "get_persona": {
      const id = str(result.id);
      if (!id) break;
      out.push(
        card("persona", `persona:${id}`, {
          title: str(result.name) ?? "Persona",
          subtitle: str(result.tone),
          fields: fields(["Role", str(result.role)], ["Audience", str(result.audience)]),
          body: body(str(result.bio) ?? str(result.description)),
        }),
      );
      break;
    }

    case "get_metric_summary": {
      const subjectType = str(result.subjectType);
      const window = str(result.window);
      if (!subjectType || !window) break;
      const subjectId = str(result.subjectId);
      out.push(
        card("metric", subjectId ? `${subjectType}:${subjectId}` : `metrics:${subjectType}`, {
          title: `${subjectType} metrics`,
          // The window is what makes the number mean anything — Sprint 55's
          // rule that cumulative and periodic values are different questions.
          subtitle: str(result.windowKind) ? `${window} · ${str(result.windowKind)}` : window,
          fields: metricFields(result),
        }),
      );
      break;
    }

    case "get_workspace_insights": {
      out.push(
        card("metric", "workspace:insights", {
          title: "Workspace performance",
          subtitle: "all campaigns and channels",
          fields: metricFields(result),
        }),
      );
      break;
    }

    case "get_sequence_funnel": {
      const id = str(input.sequenceId);
      if (!id) break;
      out.push(
        card("metric", `outreach_sequence:${id}`, {
          title: str(result.sequenceName) ?? str(result.name) ?? "Outreach sequence",
          subtitle: "funnel",
          fields: fields(
            ["Sent", num(result.sent)],
            ["Opened", num(result.opened)],
            ["Replied", num(result.replied)],
            ["Bounced", num(result.bounced)],
            ...(metricFields(result).map((f) => [f.label, f.value] as [string, string])),
          ),
        }),
      );
      break;
    }

    case "search_evidence": {
      for (const raw of arr(result.results)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.documentId);
        if (!id) continue;
        const score = num(raw.score);
        out.push(
          card("evidence", `evidence:${id}`, {
            title: str(raw.title) ?? "Evidence document",
            subtitle: score === null ? null : `relevance ${score.toFixed(2)}`,
            body: body(str(raw.text) ?? str(raw.snippet) ?? str(raw.content)),
          }),
        );
      }
      break;
    }

    case "search_discovery_items": {
      for (const raw of arr(result.items)) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push(
          card("signal", `discovery_item:${id}`, {
            title: str(raw.title) ?? "Discovery item",
            subtitle: str(raw.status),
            fields: fields(["Source", str(raw.source)], ["Author", str(raw.author)]),
            // A discovery item is attacker-controlled text. It renders inside
            // the card's body, never as its title's only content, and the
            // Sprint 78 taint tracker has already seen it.
            body: body(str(raw.summary) ?? str(raw.content)),
          }),
        );
      }
      break;
    }

    case "get_brain_section": {
      const sections = arr(result.sections);
      const rows = sections.length > 0 ? sections : [result];
      for (const raw of rows) {
        if (!isRecord(raw)) continue;
        const docType = str(raw.docType);
        const sectionId = str(raw.sectionId);
        if (!docType || !sectionId) continue;
        out.push(
          card("brain", `brain:${docType}#${sectionId}`, {
            title: str(raw.heading) ?? sectionId,
            subtitle: docType,
            body: body(str(raw.content) ?? str(raw.text)),
          }),
        );
      }
      break;
    }

    default:
      break;
  }

  return out;
}

/** Union of a turn's cards; first occurrence wins on `kind:ref`, capped. */
export function dedupeCards(cards: ChatCard[]): ChatCard[] {
  const seen = new Set<string>();
  const out: ChatCard[] = [];
  for (const item of cards) {
    const key = `${item.kind}:${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= CHAT_CARDS_PER_TURN) break;
  }
  return out;
}

/** The declared kind for a tool, or null when it renders no cards. */
export function cardKindForTool(toolName: string): ChatCardKind | null {
  return (TOOL_CARD_KINDS as Record<string, ChatCardKind | undefined>)[toolName] ?? null;
}
