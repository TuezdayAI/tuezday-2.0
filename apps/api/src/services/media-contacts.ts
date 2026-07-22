import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  createMediaContactInputSchema,
  MEDIA_CONTACT_TYPES,
  type CreateMediaContactInput,
  type MediaContact,
  type MediaContactType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, mediaContacts, type MediaContactRow } from "../db/schema";
import { parseCsvLine, type ImportResult } from "./leads";
import {
  deriveEmailSendIdempotencyKey,
  prepareEmailAction,
} from "./external-action-email";
import type { ExternalActionCommand } from "./external-action-coordinator";

export class PrDraftEmailError extends Error {
  constructor(
    readonly code: "draft_not_found" | "draft_not_approved" | "draft_not_pitch" | "contact_not_found",
    message: string,
  ) {
    super(message);
    this.name = "PrDraftEmailError";
  }
}

export function preparePrDraftEmailAction(
  db: Db,
  workspaceId: string,
  draftId: string,
): ExternalActionCommand {
  const draft = db.select().from(drafts).where(
    and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)),
  ).get();
  if (!draft) throw new PrDraftEmailError("draft_not_found", "PR pitch draft not found.");
  if (draft.state !== "approved") {
    throw new PrDraftEmailError("draft_not_approved", "Approve this pitch before sending it.");
  }
  if (draft.channel !== "pr" || draft.taskType !== "pr_pitch") {
    throw new PrDraftEmailError("draft_not_pitch", "This draft is not a media pitch.");
  }
  if (!draft.mediaContactId || !getMediaContact(db, workspaceId, draft.mediaContactId)) {
    throw new PrDraftEmailError("contact_not_found", "This pitch is not linked to a current media contact.");
  }
  return prepareEmailAction(db, workspaceId, {
    origin: "pr_draft",
    originId: draft.id,
    idempotencyKey: deriveEmailSendIdempotencyKey(draft.id, {
      draftId: draft.id,
      content: draft.content,
      stepNumber: null,
    }),
  });
}

function rowToContact(row: MediaContactRow): MediaContact {
  return { ...row, type: row.type as MediaContactType };
}

export function createMediaContact(
  db: Db,
  workspaceId: string,
  input: CreateMediaContactInput,
): MediaContact {
  const row: MediaContactRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    email: input.email.toLowerCase(),
    type: input.type,
    outlet: input.outlet,
    beat: input.beat,
    coverageNotes: input.coverageNotes,
    createdAt: Date.now(),
  };
  db.insert(mediaContacts).values(row).run();
  return rowToContact(row);
}

export function listMediaContacts(db: Db, workspaceId: string): MediaContact[] {
  return db
    .select()
    .from(mediaContacts)
    .where(eq(mediaContacts.workspaceId, workspaceId))
    .orderBy(desc(mediaContacts.createdAt))
    .all()
    .map(rowToContact);
}

export function getMediaContact(
  db: Db,
  workspaceId: string,
  contactId: string,
): MediaContact | undefined {
  const row = db
    .select()
    .from(mediaContacts)
    .where(and(eq(mediaContacts.workspaceId, workspaceId), eq(mediaContacts.id, contactId)))
    .get();
  return row ? rowToContact(row) : undefined;
}

export function deleteMediaContact(db: Db, workspaceId: string, contactId: string): boolean {
  if (!getMediaContact(db, workspaceId, contactId)) return false;
  db.delete(mediaContacts).where(eq(mediaContacts.id, contactId)).run();
  return true;
}

// ---------------------------------------------------------------------------
// CSV import — same machinery as leads, with media-list header vocabulary.
// ---------------------------------------------------------------------------

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  "full name": "name",
  email: "email",
  "email address": "email",
  type: "type",
  outlet: "outlet",
  publication: "outlet",
  show: "outlet",
  beat: "beat",
  "coverage area": "beat",
  topics: "beat",
  "coverage notes": "coverageNotes",
  notes: "coverageNotes",
  note: "coverageNotes",
};

export function importMediaContactsCsv(db: Db, workspaceId: string, csv: string): ImportResult {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return {
      imported: 0,
      skipped: 0,
      errors: ["CSV needs a header row and at least one contact row."],
    };
  }

  const headers = parseCsvLine(lines[0]!).map(
    (h) => HEADER_ALIASES[h.toLowerCase()] ?? h.toLowerCase(),
  );
  if (!headers.includes("email")) {
    return { imported: 0, skipped: 0, errors: ['CSV needs an "email" column.'] };
  }

  const existingEmails = new Set(
    listMediaContacts(db, workspaceId).map((c) => c.email.toLowerCase()),
  );
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = fields[i] ?? "";
    });

    // Unknown type values (a "columnist", an "influencer") fall back to
    // journalist instead of skipping the row — the email is what matters.
    const type = (MEDIA_CONTACT_TYPES as readonly string[]).includes(
      record.type?.toLowerCase() ?? "",
    )
      ? (record.type!.toLowerCase() as MediaContactType)
      : "journalist";

    const parsed = createMediaContactInputSchema.safeParse({
      name: record.name || record.email,
      email: record.email,
      type,
      outlet: record.outlet ?? "",
      beat: record.beat ?? "",
      coverageNotes: record.coverageNotes ?? "",
    });
    if (!parsed.success) {
      result.skipped += 1;
      result.errors.push(`Skipped "${(record.email || line).slice(0, 50)}": invalid row.`);
      continue;
    }
    if (existingEmails.has(parsed.data.email.toLowerCase())) {
      result.skipped += 1;
      continue;
    }
    createMediaContact(db, workspaceId, parsed.data);
    existingEmails.add(parsed.data.email.toLowerCase());
    result.imported += 1;
  }
  return result;
}
