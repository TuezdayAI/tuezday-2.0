import { and, eq, gte, lte } from "drizzle-orm";
import type { CalendarEntry, CalendarEntryStatus, Channel } from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, postingCadences, publications } from "../db/schema";
import { deriveTitle, listCadenceRows, slotsBetween } from "./cadences";

export interface CalendarView {
  from: number;
  to: number;
  entries: CalendarEntry[];
}

/**
 * Workspace-wide "what's going out when": publications (scheduled/published/
 * failed) in the window plus every active cadence's still-open upcoming slots.
 */
export function buildCalendar(db: Db, workspaceId: string, fromMs: number, toMs: number): CalendarView {
  const entries: CalendarEntry[] = [];

  const rows = db
    .select({ publication: publications, draft: drafts, cadence: postingCadences })
    .from(publications)
    .leftJoin(drafts, eq(publications.draftId, drafts.id))
    .leftJoin(postingCadences, eq(publications.cadenceId, postingCadences.id))
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        gte(publications.scheduledFor, fromMs),
        lte(publications.scheduledFor, toMs),
      ),
    )
    .all();

  // Slots already covered by a publication, per cadence, so we don't double-list.
  const covered = new Map<string, Set<number>>();
  for (const { publication, draft, cadence } of rows) {
    entries.push({
      kind: "publication",
      at: publication.scheduledFor,
      cadenceId: publication.cadenceId,
      cadenceName: cadence?.name ?? null,
      channel: (draft?.channel as Channel | undefined) ?? null,
      providerKey: publication.providerKey,
      status: publication.status as CalendarEntryStatus,
      title: publication.title || (draft ? deriveTitle(draft.content) : "Post"),
      draftId: publication.draftId,
      publicationId: publication.id,
      url: publication.externalUrl,
    });
    if (publication.cadenceId) {
      const set = covered.get(publication.cadenceId) ?? new Set<number>();
      set.add(publication.scheduledFor);
      covered.set(publication.cadenceId, set);
    }
  }

  for (const cadence of listCadenceRows(db, workspaceId)) {
    if (cadence.status !== "active") continue;
    const cov = covered.get(cadence.id) ?? new Set<number>();
    for (const at of slotsBetween(cadence, fromMs, toMs)) {
      if (cov.has(at)) continue;
      entries.push({
        kind: "slot",
        at,
        cadenceId: cadence.id,
        cadenceName: cadence.name,
        channel: cadence.channel,
        providerKey: null,
        status: "open",
        title: `Open slot — ${cadence.name}`,
        draftId: null,
        publicationId: null,
        url: null,
      });
    }
  }

  entries.sort((a, b) => a.at - b.at);
  return { from: fromMs, to: toMs, entries };
}
