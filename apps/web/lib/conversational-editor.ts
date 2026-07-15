import type {
  AutomationMode,
  DraftEditorContext,
  EditorContextSection,
  EditorStaleness,
  ExecutionResult,
  Publication,
  PublishDraftInput,
} from "@tuezday/contracts";
import { executionTargetHref } from "./execution-results";

export type EditorVersionId = "original" | "current" | `revision:${string}`;

export interface EditorVersionOption {
  id: EditorVersionId;
  label: string;
}

export function editorVersionOptions(context: DraftEditorContext): EditorVersionOption[] {
  return [
    { id: "original", label: "Original" },
    { id: "current", label: "Current" },
    ...context.turns
      .filter((turn) => turn.status === "completed")
      .map((turn, index) => ({
        id: `revision:${turn.id}` as const,
        label: `Revision ${index + 1}`,
      })),
  ];
}

export function editorVersionContent(
  context: DraftEditorContext,
  version: EditorVersionId,
): string {
  if (version === "original") return context.draft.originalContent;
  if (version === "current") return context.draft.content;
  return (
    context.turns.find((turn) => `revision:${turn.id}` === version)?.resultContent ??
    context.draft.content
  );
}

export function groupEditorSections(sections: EditorContextSection[]) {
  const byLayer: Record<string, EditorContextSection[]> = {};
  for (const section of sections) {
    (byLayer[section.layer] ??= []).push(section);
  }
  return {
    included: sections.filter((section) => section.included),
    excluded: sections.filter((section) => !section.included),
    byLayer,
  };
}

export function automationExplanation(mode: AutomationMode): string {
  switch (mode) {
    case "scheduled_auto":
      return "Scheduled automation may approve and post eligible work under the campaign policy. External-action authorization remains a separate decision.";
    case "human_in_the_loop":
      return "Tuezday can prepare and schedule work, but publishing waits for your approval and any required external-action authorization.";
    case "manual":
      return "Nothing posts automatically: you stay in control of content approval, scheduling, and every external action.";
  }
}

export function stalenessExplanation(staleness: EditorStaleness): string {
  return staleness.stale
    ? "The campaign plan changed after this version was made. Revise again to apply the latest plan."
    : staleness.reason;
}

export interface PublishEligibility {
  eligible: boolean;
  reason: string | null;
}

/** A publication may only be proposed from approved content aimed at a
 * connected destination — everything else names the missing prerequisite. */
export function publishEligibility(context: DraftEditorContext): PublishEligibility {
  if (context.draft.state !== "approved") {
    return {
      eligible: false,
      reason: "Approve the content first — publication is proposed from approved content only.",
    };
  }
  if (!context.destination) {
    return {
      eligible: false,
      reason: `Connect a ${context.draft.channel} destination on Integrations before proposing a publication.`,
    };
  }
  if (context.destination.status !== "connected") {
    return {
      eligible: false,
      reason: `The ${context.destination.label} connection is ${context.destination.status}${
        context.destination.error ? ` (${context.destination.error})` : ""
      }. Reconnect it before proposing a publication.`,
    };
  }
  return { eligible: true, reason: null };
}

export function initialPublishFields(context: DraftEditorContext): {
  target: string;
  title: string;
} {
  const firstLine = (context.draft.content.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  return {
    title: (firstLine || context.draft.taskType.replaceAll("_", " ")).slice(0, 300),
    target: "feed",
  };
}

/** Build the publish proposal body. The idempotency key is retained across
 * retries of the identical request so a network blip never double-proposes. */
export function publishActionPayload(input: {
  connectionId: string;
  target: string;
  title: string;
  /** datetime-local value; empty string means immediately once authorized. */
  scheduledForLocal: string;
  idempotencyKey: string;
}): PublishDraftInput {
  const scheduledFor = input.scheduledForLocal
    ? new Date(input.scheduledForLocal).getTime()
    : undefined;
  return {
    connectionId: input.connectionId,
    target: input.target.trim().replace(/^r\//, ""),
    title: input.title.trim(),
    ...(scheduledFor ? { scheduledFor } : {}),
    idempotencyKey: input.idempotencyKey,
  };
}

export function editorRecoveryHref(
  workspaceId: string,
  item: ExecutionResult | Publication,
): string {
  if ("kind" in item) return executionTargetHref(workspaceId, item);
  return item.status === "scheduled"
    ? `/workspaces/${workspaceId}/calendar`
    : `/workspaces/${workspaceId}/content`;
}
