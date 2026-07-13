import type {
  AutomationMode,
  DraftEditorContext,
  EditorContextSection,
  EditorStaleness,
  ExecutionResult,
  Publication,
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

export function editorRecoveryHref(
  workspaceId: string,
  item: ExecutionResult | Publication,
): string {
  if ("kind" in item) return executionTargetHref(workspaceId, item);
  return item.status === "scheduled"
    ? `/workspaces/${workspaceId}/calendar`
    : `/workspaces/${workspaceId}/content`;
}
