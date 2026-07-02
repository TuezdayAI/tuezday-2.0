import { describe, expect, it } from "vitest";
import {
  BRAIN_DOC_TOKEN_WARNING,
  DEFAULT_TASK_DOC_MATRIX,
  DOC_CONTEXT_MODES,
  MATRIX_CELL_REASON_MAX_CHARS,
  MATRIX_DOC_TYPES,
  RESOLVE_MODES,
  TASK_TYPES,
  ZOOM_DOC_TOKEN_CAP,
  ZOOM_MAX_SECTIONS_PER_DOC,
  ZOOM_SMALL_DOC_TOKENS,
  docOutlineSchema,
  matrixCellSchema,
  updateMatrixCellInputSchema,
} from "../src/index";

describe("selective context (Sprint 43)", () => {
  it("defines the doc context modes and resolve modes", () => {
    expect(DOC_CONTEXT_MODES).toEqual(["full", "outline", "omit"]);
    expect(RESOLVE_MODES).toEqual(["draft", "brief"]);
    expect(MATRIX_DOC_TYPES).toEqual(["icp", "history"]);
  });

  it("ships sane zoom constants", () => {
    expect(ZOOM_SMALL_DOC_TOKENS).toBeGreaterThan(0);
    expect(ZOOM_DOC_TOKEN_CAP).toBeGreaterThan(ZOOM_SMALL_DOC_TOKENS);
    expect(ZOOM_MAX_SECTIONS_PER_DOC).toBeGreaterThanOrEqual(1);
    expect(BRAIN_DOC_TOKEN_WARNING).toBeGreaterThan(0);
  });

  it("DEFAULT_TASK_DOC_MATRIX is total: every task type × every matrix doc", () => {
    for (const taskType of TASK_TYPES) {
      const row = DEFAULT_TASK_DOC_MATRIX[taskType];
      expect(row, `missing row for ${taskType}`).toBeDefined();
      for (const docType of MATRIX_DOC_TYPES) {
        const cell = row[docType];
        expect(cell, `missing cell for ${taskType} × ${docType}`).toBeDefined();
        expect(DOC_CONTEXT_MODES).toContain(cell.mode);
        expect(cell.reason.trim().length, `${taskType} × ${docType} needs a reason`).toBeGreaterThan(0);
        expect(cell.reason.length).toBeLessThanOrEqual(MATRIX_CELL_REASON_MAX_CHARS);
      }
    }
  });

  it("pins the load-bearing default cells from the gap assessment", () => {
    expect(DEFAULT_TASK_DOC_MATRIX.outbound_email.icp.mode).toBe("full");
    expect(DEFAULT_TASK_DOC_MATRIX.linkedin_post.history.mode).toBe("outline");
    expect(DEFAULT_TASK_DOC_MATRIX.pr_pitch.history.mode).toBe("full");
    expect(DEFAULT_TASK_DOC_MATRIX.engagement_reply.icp.mode).toBe("omit");
  });

  it("updateMatrixCellInputSchema validates mode and bounds the reason", () => {
    expect(updateMatrixCellInputSchema.safeParse({ mode: "outline" }).success).toBe(true);
    expect(
      updateMatrixCellInputSchema.safeParse({ mode: "full", reason: "we sell to devs" }).success,
    ).toBe(true);
    expect(updateMatrixCellInputSchema.safeParse({ mode: "verbatim" }).success).toBe(false);
    expect(updateMatrixCellInputSchema.safeParse({}).success).toBe(false);
    expect(
      updateMatrixCellInputSchema.safeParse({
        mode: "omit",
        reason: "x".repeat(MATRIX_CELL_REASON_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("matrixCellSchema round-trips a merged cell", () => {
    const cell = {
      taskType: "linkedin_post",
      docType: "history",
      mode: "outline",
      reason: "Lessons zoom in per topic.",
      source: "workspace",
      updatedAt: 1_700_000_000_000,
    };
    expect(matrixCellSchema.safeParse(cell).success).toBe(true);
    expect(matrixCellSchema.safeParse({ ...cell, docType: "soul" }).success).toBe(false);
  });

  it("docOutlineSchema round-trips a parsed outline", () => {
    const outline = {
      generatedAt: 1_700_000_000_000,
      sections: [
        {
          id: "(preamble)",
          parentId: null,
          heading: "(preamble)",
          level: 2,
          summary: "Why the company exists.",
          summarySource: "fallback",
          tokens: 120,
        },
        {
          id: "operating-principles/brain-first",
          parentId: "operating-principles",
          heading: "Brain first",
          level: 3,
          summary: "The brain is the platform primitive.",
          summarySource: "llm",
          tokens: 45,
        },
      ],
    };
    expect(docOutlineSchema.safeParse(outline).success).toBe(true);
    expect(
      docOutlineSchema.safeParse({
        ...outline,
        sections: [{ ...outline.sections[0], level: 4 }],
      }).success,
    ).toBe(false);
  });
});
