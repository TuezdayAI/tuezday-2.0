import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums — fixed by the rebuild plan. Do not extend casually: every module
// must share these exact values.
// ---------------------------------------------------------------------------

/** The five human-readable brain documents every workspace owns. */
export const BRAIN_DOC_TYPES = ["soul", "icp", "voice", "history", "now"] as const;
export type BrainDocType = (typeof BRAIN_DOC_TYPES)[number];

/** Approval gate states for any generated draft. */
export const APPROVAL_STATES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "edited",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Output ratings stored as training signals. */
export const OUTPUT_RATINGS = ["accepted", "needs_edit", "rejected"] as const;
export type OutputRating = (typeof OUTPUT_RATINGS)[number];

/** GTM task types the resolver and generation sandbox understand. */
export const TASK_TYPES = [
  "linkedin_post",
  "cold_email_opener",
  "ad_copy_variant",
  "landing_page_hero",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Channels a task can target. */
export const CHANNELS = ["linkedin", "x", "email", "ads", "web"] as const;
export type Channel = (typeof CHANNELS)[number];

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be 100 characters or fewer"),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

// ---------------------------------------------------------------------------
// Brain documents
// ---------------------------------------------------------------------------

export const BRAIN_DOC_MAX_CHARS = 50_000;

export const brainDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  docType: z.enum(BRAIN_DOC_TYPES),
  content: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type BrainDocument = z.infer<typeof brainDocumentSchema>;

export const updateBrainDocInputSchema = z.object({
  content: z
    .string()
    .max(BRAIN_DOC_MAX_CHARS, `Document must be ${BRAIN_DOC_MAX_CHARS} characters or fewer`),
});
export type UpdateBrainDocInput = z.infer<typeof updateBrainDocInputSchema>;

export const brainDocVersionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  version: z.number().int().min(1),
  content: z.string(),
  createdAt: z.number().int(),
});
export type BrainDocVersion = z.infer<typeof brainDocVersionSchema>;

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export const PERSONA_OVERLAY_MAX_CHARS = 10_000;

export const personaSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  overlay: z.string().max(PERSONA_OVERLAY_MAX_CHARS),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Persona = z.infer<typeof personaSchema>;

export const upsertPersonaInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Persona name is required")
    .max(100, "Persona name must be 100 characters or fewer"),
  description: z.string().trim().max(500, "Description must be 500 characters or fewer").default(""),
  overlay: z
    .string()
    .max(PERSONA_OVERLAY_MAX_CHARS, `Overlay must be ${PERSONA_OVERLAY_MAX_CHARS} characters or fewer`)
    .default(""),
});
export type UpsertPersonaInput = z.infer<typeof upsertPersonaInputSchema>;

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 8_000;

export const resolveRequestSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
});
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

// ---------------------------------------------------------------------------
// API error shape
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
