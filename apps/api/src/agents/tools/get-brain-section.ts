import type { z } from "zod";
import { toolInputSchemas, type BrainDocType } from "@tuezday/contracts";
import { parseDocSections, rankSections, type ZoomCandidate } from "@tuezday/brain";
import { getBrain } from "../../services/brain";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.get_brain_section;
type Input = z.infer<typeof input>;

const SECTION_LIMIT = 6;
const BODY_CHARS = 320;
const FULL_SECTION_CHARS = 2000;

/**
 * Read the workspace brain: either one exact section by id, or a BM25-ranked
 * search across doc sections (the proven Sprint 42 copilot pipeline).
 * Cross-field rules live here, not in the zod schema, so violations return
 * as instructive error data the model can react to.
 */
export const getBrainSectionTool: Tool<Input, unknown> = {
  name: "get_brain_section",
  description:
    "Read the workspace's brain docs (soul, icp, voice, history, now). Two modes: pass docType + sectionId for one exact section verbatim, or pass query (optionally with docType to narrow) to get the most relevant sections. Use for identity, ICP, voice, strategy, and current-focus questions.",
  input,
  access: "read",
  async run(ctx, { docType, sectionId, query }) {
    const { docs } = getBrain(ctx.db, ctx.workspaceId);

    if (sectionId) {
      if (!docType) {
        return {
          error: "invalid_arguments",
          note: "sectionId requires docType (section ids are unique per doc).",
        };
      }
      const doc = docs.find((d) => d.docType === docType);
      const sections = doc?.content.trim() ? parseDocSections(doc.content) : [];
      const section = sections.find((s) => s.id === sectionId);
      if (!section) {
        return {
          error: "not_found",
          note: `No section "${sectionId}" in ${docType}.`,
          availableSectionIds: sections.map((s) => s.id).slice(0, 30),
        };
      }
      return {
        docType,
        sectionId: section.id,
        heading: section.heading,
        content: compactText(section.body, FULL_SECTION_CHARS),
      };
    }

    if (!query) {
      return {
        error: "invalid_arguments",
        note: "Provide either docType + sectionId, or a query.",
      };
    }

    const candidates: ZoomCandidate[] = [];
    for (const doc of docs) {
      if (docType && doc.docType !== docType) continue;
      if (!doc.content.trim()) continue;
      for (const section of parseDocSections(doc.content)) {
        candidates.push({ docType: doc.docType as BrainDocType, section });
      }
    }
    if (candidates.length === 0) {
      return { sections: [], note: "The brain has no written content yet." };
    }

    const ranked = rankSections(query, candidates);
    // BM25 finds nothing when no query term matched — fall back to canonical
    // doc order so the model always gets grounding.
    const chosen = (ranked.length > 0 ? ranked : candidates).slice(0, SECTION_LIMIT);
    return {
      sections: chosen.map((c) => ({
        docType: c.docType,
        sectionId: c.section.id,
        heading: c.section.heading,
        text: compactText(c.section.body, BODY_CHARS),
      })),
      ...(ranked.length === 0
        ? { note: "No section matched the query terms; returning the leading sections instead." }
        : {}),
    };
  },
};
