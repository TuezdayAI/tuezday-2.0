import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { designTemplates, type DesignTemplateRow } from "../db/schema";
import type { DesignProvider } from "./provider";

// Template cache (Sprint 41 Part 3). Open Design authors a template ONCE per
// (workspace, design system, skill, fingerprint, slide shape); every render
// after that is a cache hit — this function is the cost guarantee. A design
// edit changes the fingerprint so the stale row simply never matches again
// (no explicit invalidation pass), and old rows stay put, which keeps
// previously approved creatives reproducible.

export interface TemplateLookup {
  workspaceId: string;
  designSystemId: string;
  skillId: string;
  slideShape: string;
  /** Output of resolveDesignSystem() — base + winning overlay. */
  resolvedDesignMarkdown: string;
  /** Passed to the provider on a miss. */
  brief: string;
}

export function designSystemFingerprint(resolvedDesignMarkdown: string): string {
  return createHash("sha256").update(resolvedDesignMarkdown).digest("hex");
}

export async function getOrAuthorTemplate(
  db: Db,
  provider: DesignProvider,
  input: TemplateLookup,
): Promise<DesignTemplateRow> {
  const fingerprint = designSystemFingerprint(input.resolvedDesignMarkdown);
  const existing = db
    .select()
    .from(designTemplates)
    .where(
      and(
        eq(designTemplates.workspaceId, input.workspaceId),
        eq(designTemplates.designSystemId, input.designSystemId),
        eq(designTemplates.skillId, input.skillId),
        eq(designTemplates.designSystemFingerprint, fingerprint),
        eq(designTemplates.slideShape, input.slideShape),
      ),
    )
    .get();
  if (existing) return existing;

  const authored = await provider.authorTemplate({
    skillId: input.skillId,
    designSystemMarkdown: input.resolvedDesignMarkdown,
    slideShape: input.slideShape,
    brief: input.brief,
  });

  const row: DesignTemplateRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    designSystemId: input.designSystemId,
    skillId: input.skillId,
    designSystemFingerprint: fingerprint,
    slideShape: input.slideShape,
    html: authored.html,
    css: authored.css,
    placeholders: JSON.stringify(authored.placeholders),
    createdAt: Date.now(),
  };
  db.insert(designTemplates).values(row).run();
  return row;
}
