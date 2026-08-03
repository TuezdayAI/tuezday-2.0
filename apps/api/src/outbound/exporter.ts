import { csvField } from "../services/leads";

/**
 * Manual data export for approved outbound email (Sprint 26; reframed in
 * Sprint 51).
 *
 * This is NOT how Tuezday sends. Email delivery is native and governed: an
 * approved message is dispatched as a durable `send` external action from the
 * workspace's verified sender (`services/launches.ts` → `prepareEmailAction`,
 * and `POST /workspaces/:id/outbound/drafts/:draftId/send`). Nothing in any
 * send or dispatch path calls this interface.
 *
 * What it is: an export-only affordance so a founder who wants to run their
 * own tooling can download a copy of their approved messages. Downloading the
 * file is a data export, not a routing decision.
 */
export interface OutboundRecipientMessage {
  name: string;
  email: string;
  company: string;
  role: string;
  /** The per-recipient personalized first-touch body. */
  body: string;
}

export interface OutboundExport {
  filename: string;
  contentType: string;
  content: string;
}

export interface OutboundExporter {
  /** Identifier for the export format (e.g. "csv"). */
  format: string;
  export(messages: OutboundRecipientMessage[]): OutboundExport;
}

/** Best-effort first/last split of a display name for the export columns. */
function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { first: name.trim(), last: "" };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/**
 * The default export format: standard lead columns plus the personalized body
 * as a `personalized_message` column. Shaped so a founder can feed it to
 * whatever tooling they already run — it is a download, not a send.
 */
export class CsvOutboundExporter implements OutboundExporter {
  readonly format = "csv";

  export(messages: OutboundRecipientMessage[]): OutboundExport {
    const lines = ["email,first_name,last_name,company,role,personalized_message"];
    for (const m of messages) {
      const { first, last } = splitName(m.name);
      lines.push([m.email, first, last, m.company, m.role, m.body].map(csvField).join(","));
    }
    return {
      filename: "tuezday-launch-email.csv",
      contentType: "text/csv; charset=utf-8",
      content: lines.join("\n"),
    };
  }
}
