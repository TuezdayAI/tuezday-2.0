import type { ChatProposalIntent, ProposeToolName } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// The statement of intent (Sprint 78).
//
// A pure function from a propose tool's validated arguments to the card the
// founder confirms. Structured rather than prose for two reasons: the founder
// should be able to *check* a proposal field by field rather than read a
// paragraph and trust it, and Sprint 77's card registry needs a contract to
// adopt rather than a sentence to parse.
//
// The `effect` line always says what does NOT happen as well as what does.
// "Submit a draft for review" and "publish a post" are one confirmation click
// apart in this UI and a world apart in consequence, and the difference has to
// be legible without knowing how the platform is wired.
// ---------------------------------------------------------------------------

const PREVIEW_CHARS = 400;

function preview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= PREVIEW_CHARS
    ? trimmed
    : `${trimmed.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function when(scheduledFor: number | undefined): string {
  return scheduledFor ? new Date(scheduledFor).toISOString().replace("T", " ").slice(0, 16) : "As soon as it clears";
}

type Args = Record<string, unknown>;

const str = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const num = (args: Args, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;

/**
 * Names for the ids the model passes. Resolving them to titles needs the db,
 * which this module deliberately does not have — the caller passes what it
 * already looked up, and an unresolved id renders as the id rather than as
 * nothing. A card that says "campaign 9f3c…" is worse than one that says
 * "Spring Launch" and far better than one that hides the binding entirely.
 */
export interface IntentNames {
  campaignName?: string | null;
  personaName?: string | null;
  draftTitle?: string | null;
  launchName?: string | null;
}

export function buildProposalIntent(
  tool: ProposeToolName,
  args: Args,
  names: IntentNames = {},
): ChatProposalIntent {
  const rationale = str(args, "rationale") ?? "";
  const detail: { label: string; value: string }[] = [];

  switch (tool) {
    case "propose_draft": {
      const channel = str(args, "channel") ?? "unknown channel";
      const content = str(args, "content") ?? "";
      detail.push({ label: "Channel", value: channel });
      if (str(args, "taskType")) detail.push({ label: "Type", value: str(args, "taskType")! });
      if (args.campaignId) {
        detail.push({ label: "Campaign", value: names.campaignName ?? String(args.campaignId) });
      }
      if (args.personaId) {
        detail.push({ label: "Persona", value: names.personaName ?? String(args.personaId) });
      }
      detail.push({ label: "Content", value: preview(content) });
      return {
        title: `Submit a ${channel} draft for review`,
        detail,
        effect:
          "It goes into your approval queue as a draft. Nothing is published, scheduled or sent — you read it in Review and decide.",
        rationale,
      };
    }

    case "propose_publication": {
      detail.push({
        label: "Draft",
        value: names.draftTitle ?? String(args.draftId ?? "unknown draft"),
      });
      if (str(args, "target")) detail.push({ label: "Destination", value: str(args, "target")! });
      detail.push({ label: "When", value: when(num(args, "scheduledFor")) });
      return {
        title: "Publish an approved draft",
        detail,
        effect:
          "This asks to post already-approved content to its social account. Your action policy decides what happens next: under `human_required` it waits in the authorization queue, under `autonomous` it goes out. Unapproved drafts are refused.",
        rationale,
      };
    }

    case "propose_reply": {
      detail.push({ label: "Inbox item", value: String(args.inboxItemId ?? "unknown item") });
      return {
        title: "Post the approved reply to an inbox item",
        detail,
        effect:
          "This asks to post a reply that has already cleared review. Your action policy decides whether it posts now or waits for you to authorize it.",
        rationale,
      };
    }

    case "propose_sequence_step": {
      detail.push({ label: "Sequence message", value: String(args.launchMessageId ?? "unknown message") });
      return {
        title: "Send one outbound sequence message",
        detail,
        effect:
          "This sends real email to a real recipient from your verified sender, once your action policy allows it. Suppression, recipient permission and unsubscribe are enforced by the platform.",
        rationale,
      };
    }

    case "propose_ad_mutation": {
      const launch = names.launchName ?? String(args.launchId ?? "unknown launch");
      detail.push({ label: "Ad launch", value: launch });
      const budget = num(args, "dailyBudgetCents");
      if (budget !== undefined) {
        detail.push({ label: "New daily budget", value: money(budget) });
        return {
          title: `Change the daily budget on "${launch}"`,
          detail,
          effect:
            "This changes live ad spend. Your action policy decides whether it applies immediately or waits for your authorization.",
          rationale,
        };
      }
      const countries = Array.isArray(args.countries) ? (args.countries as string[]).join(", ") : "";
      detail.push({ label: "Countries", value: countries || "unchanged" });
      detail.push({
        label: "Age range",
        value: `${num(args, "ageMin") ?? "?"}–${num(args, "ageMax") ?? "?"}`,
      });
      return {
        title: `Change the targeting on "${launch}"`,
        detail,
        effect:
          "This replaces the whole targeting spec on a live ad launch — anything not listed here is reset. Your action policy decides whether it applies immediately or waits for your authorization.",
        rationale,
      };
    }

    default: {
      // Unreachable while ProposeToolName is exhaustive; a new propose tool
      // that forgets a card gets a legible fallback rather than a blank one.
      const exhaustive: never = tool;
      return {
        title: `Run ${String(exhaustive)}`,
        detail: [{ label: "Arguments", value: preview(JSON.stringify(args)) }],
        effect: "This goes through the workspace's action policy before anything happens.",
        rationale,
      };
    }
  }
}
