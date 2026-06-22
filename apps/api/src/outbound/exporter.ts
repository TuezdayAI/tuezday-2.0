import { csvField } from "../services/leads";

/**
 * The outbound-email hand-off boundary (Sprint 26). The launch domain never
 * learns how email actually leaves Tuezday — today that's a CSV the founder
 * uploads to Smartlead/Instantly; a future impl pushes via their API (see
 * docs/deferred-improvements.md #1). Swap the implementation behind this
 * interface without touching the launch service.
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
 * A Smartlead/Instantly-ready CSV: standard lead columns plus the personalized
 * body as a custom variable column they map to `{{personalized_message}}`.
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
