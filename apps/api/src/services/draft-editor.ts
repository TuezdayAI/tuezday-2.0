import { and, asc, eq, ne } from "drizzle-orm";
import {
  draftEditorContextSchema,
  editDraftInputSchema,
  isAdCreativeTaskType,
  publicationSchema,
  transitionTo,
  validateAdCreative,
  type Draft,
  type DraftEditorContext,
  type DraftRevisionTurn,
  type EditorContextSection,
  type EditorEvidenceCitation,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents, type ContextSection } from "@tuezday/brain";
import type { Db } from "../db";
import { drafts, evidenceDocuments, generations } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
import { getCurrentCampaignPlan } from "./campaign-plans";
import { composeResolveCampaign, getCampaign } from "./campaigns";
import { listConnections, providerByKey } from "./connections";
import {
  applyDraftActionInTransaction,
  getDraft,
  InvalidTransitionError,
  listDecisions,
  type DraftActor,
} from "./drafts";
import {
  completeTurn,
  createRunningTurn,
  failTurn,
  getTurnByRequest,
  listRevisionTurns,
} from "./draft-revisions";
import { assertWithinLimit, getUsage } from "./entitlements";
import { retrieveEvidence } from "./evidence";
import { listExecutionResults } from "./executions";
import { listExternalActionsForDraft } from "./external-actions";
import { resolveChannelGuidance } from "./guidance";
import { getPersona, toResolvePersona } from "./personas";
import {
  providerForSocialChannel,
  resolvePersonaSocialConnection,
} from "./persona-social-accounts";
import { listPublications } from "./publications";
import { resolveDraftAccount } from "./resolve-account";
import { selectiveContextInputs } from "./resolve-input";
import { getSignal } from "./signals";
import { getWorkspace } from "./workspaces";

export class RevisionInProgressError extends Error {
  constructor() {
    super("This revision request is already running.");
    this.name = "RevisionInProgressError";
  }
}

export class DraftChangedError extends Error {
  constructor() {
    super("The draft changed while Tuezday was revising it.");
    this.name = "DraftChangedError";
  }
}

export class RevisionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionFailedError";
  }
}

function safeSourceUrl(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  try {
    const url = new URL(sourceRef);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface EvidenceDocumentLookup {
  title: string;
  kind: string;
  sourceRef: string | null;
}

function evidenceDocumentLookup(db: Db, workspaceId: string) {
  return new Map(
    db
      .select({
        r2rDocumentId: evidenceDocuments.r2rDocumentId,
        title: evidenceDocuments.title,
        kind: evidenceDocuments.kind,
        sourceRef: evidenceDocuments.sourceRef,
      })
      .from(evidenceDocuments)
      .where(eq(evidenceDocuments.workspaceId, workspaceId))
      .all()
      .flatMap((row) =>
        row.r2rDocumentId
          ? [
              [
                row.r2rDocumentId,
                { title: row.title, kind: row.kind, sourceRef: row.sourceRef },
              ] as const,
            ]
          : [],
      ),
  );
}

export function normalizeContextSections(
  sections: ContextSection[],
  evidenceByR2rId: Map<string, EvidenceDocumentLookup>,
): EditorContextSection[] {
  return sections.map((section) => {
    const chunks: EditorEvidenceCitation[] = (section.evidence?.chunks ?? []).map((chunk) => {
      const document = evidenceByR2rId.get(chunk.documentId);
      return {
        documentId: chunk.documentId,
        title: document?.title ?? chunk.title,
        kind: document?.kind ?? chunk.kind,
        url: safeSourceUrl(document?.sourceRef ?? null),
        score: chunk.score,
        finalScore: chunk.finalScore,
        kept: chunk.kept,
        exclusionReason: chunk.exclusionReason ?? null,
      };
    });
    return {
      key: section.key,
      layer: section.layer,
      title: section.title,
      content: section.content,
      included: section.included,
      reason: section.reason,
      tokens: section.tokens,
      evidence: section.evidence
        ? { query: section.evidence.query, chunks }
        : null,
    };
  });
}

function planStaleness(
  planActivatedAt: number | null,
  contextResolvedAt: number,
  hasCampaign: boolean,
) {
  if (!hasCampaign || planActivatedAt === null) {
    return {
      stale: false,
      planActivatedAt,
      contextResolvedAt,
      reason: "No active campaign plan applies.",
    };
  }
  const stale = planActivatedAt > contextResolvedAt;
  return {
    stale,
    planActivatedAt,
    contextResolvedAt,
    reason: stale
      ? "The campaign plan changed after this output last resolved its context."
      : "This output reflects the current campaign plan.",
  };
}

export function getDraftEditorContext(
  db: Db,
  workspaceId: string,
  draftId: string,
): DraftEditorContext | undefined {
  const draft = getDraft(db, workspaceId, draftId);
  if (!draft) return undefined;

  const decisions = listDecisions(db, draft.id);
  const turns = listRevisionTurns(db, workspaceId, draft.id);
  const sourceGeneration = draft.sourceGenerationId
    ? db
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.workspaceId, workspaceId),
            eq(generations.id, draft.sourceGenerationId),
          ),
        )
        .get()
    : undefined;
  const evidenceByR2rId = evidenceDocumentLookup(db, workspaceId);
  const latestCompletedTurn = turns.filter((turn) => turn.status === "completed").at(-1);
  const contextSections = latestCompletedTurn
    ? latestCompletedTurn.contextSections
    : normalizeContextSections(
        sourceGeneration
          ? (JSON.parse(sourceGeneration.sectionsJson) as ContextSection[])
          : [],
        evidenceByR2rId,
      );
  const contextResolvedAt =
    latestCompletedTurn?.completedAt ?? sourceGeneration?.createdAt ?? draft.createdAt;

  const campaign = draft.campaignId ? getCampaign(db, workspaceId, draft.campaignId) : undefined;
  const currentPlan = campaign
    ? getCurrentCampaignPlan(db, workspaceId, campaign.id)
    : undefined;
  const persona = draft.personaId ? getPersona(db, workspaceId, draft.personaId) : undefined;

  const siblings = draft.sourceSignalId
    ? db
        .select({ id: drafts.id, channel: drafts.channel, state: drafts.state })
        .from(drafts)
        .where(
          and(
            eq(drafts.workspaceId, workspaceId),
            eq(drafts.sourceSignalId, draft.sourceSignalId),
            ne(drafts.id, draft.id),
          ),
        )
        .orderBy(asc(drafts.createdAt))
        .all()
        .map((row) => ({
          draftId: row.id,
          channel: row.channel as DraftEditorContext["siblings"][number]["channel"],
          state: row.state as DraftEditorContext["siblings"][number]["state"],
        }))
    : [];

  const providerKey = providerForSocialChannel(draft.channel);
  let destination = null;
  if (providerKey) {
    const routed = draft.personaId
      ? resolvePersonaSocialConnection(db, workspaceId, {
          personaId: draft.personaId,
          providerKey,
          channel: draft.channel,
        })
      : null;
    const connection = routed?.ok
      ? routed.connection
      : listConnections(db, workspaceId).find((item) => item.providerKey === providerKey);
    if (connection) {
      destination = {
        providerKey: connection.providerKey,
        label: connection.displayName || providerByKey(connection.providerKey)?.label || connection.providerKey,
        status: connection.status,
        error: connection.lastError,
      };
    }
  }

  const publications = listPublications(db, workspaceId)
    .filter((publication) => publication.draftId === draft.id)
    .map((publication) => publicationSchema.parse(publication));
  const executions = listExecutionResults(db, workspaceId, {
    campaignId: draft.campaignId ?? undefined,
    limit: 200,
  }).filter((execution) => execution.draftId === draft.id);
  const actions = listExternalActionsForDraft(db, workspaceId, draft.id);
  const evidenceCitations = contextSections.flatMap(
    (section) => section.evidence?.chunks ?? [],
  );

  return draftEditorContextSchema.parse({
    draft,
    decisions,
    turns,
    contextSections,
    evidenceCitations,
    campaign: campaign
      ? { id: campaign.id, name: campaign.name, automationMode: campaign.automationMode }
      : null,
    persona: persona ? { id: persona.id, name: persona.name } : null,
    staleness: planStaleness(
      currentPlan?.plan.activatedAt ?? null,
      contextResolvedAt,
      Boolean(campaign),
    ),
    siblings,
    destination,
    publications,
    executions,
    actions,
  });
}

export interface ReviseDraftDeps {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
}

export interface ReviseDraftServiceInput {
  workspaceId: string;
  draftId: string;
  requestId: string;
  instruction: string;
  expectedDraftUpdatedAt: number;
  actor: DraftActor;
}

export interface ReviseDraftResult {
  draft: Draft;
  turn: DraftRevisionTurn;
}

function revisionPrompt(
  resolvedPrompt: string,
  turns: DraftRevisionTurn[],
  currentContent: string,
  instruction: string,
) {
  const recentConversation = turns
    .filter((turn) => turn.status === "completed")
    .slice(-6)
    .map((turn) => `USER: ${turn.instruction}\nTUEZDAY: ${turn.resultContent ?? ""}`)
    .join("\n\n")
    .slice(-12_000);
  return `${resolvedPrompt}\n\nREVISION RULES\nReturn only the revised deliverable. Preserve supported facts and citations. Do not explain your changes.\n\nRECENT REVISIONS\n${recentConversation || "None"}\n\nCURRENT DRAFT\n${currentContent}\n\nUSER INSTRUCTION\n${instruction}`;
}

/** Resolve live context, revise once, then atomically edit the draft and finish the turn. */
export async function reviseDraft(
  { db, llm, evidence }: ReviseDraftDeps,
  input: ReviseDraftServiceInput,
): Promise<ReviseDraftResult> {
  const existing = getTurnByRequest(db, input.workspaceId, input.draftId, input.requestId);
  if (existing) {
    if (existing.status === "running") throw new RevisionInProgressError();
    if (existing.status === "failed") throw new RevisionFailedError(existing.error ?? "Revision failed.");
    const storedDraft = getDraft(db, input.workspaceId, input.draftId);
    if (!storedDraft) throw new Error("draft_not_found");
    return { draft: storedDraft, turn: existing };
  }

  const workspace = getWorkspace(db, input.workspaceId);
  const draft = getDraft(db, input.workspaceId, input.draftId);
  if (!workspace || !draft) throw new Error("draft_not_found");
  if (draft.updatedAt !== input.expectedDraftUpdatedAt) throw new DraftChangedError();
  if (!transitionTo(draft.state, "edit")) {
    throw new InvalidTransitionError(draft.state, "edit");
  }
  assertWithinLimit(db, input.workspaceId, "monthlyGenerations", getUsage(db, input.workspaceId).monthlyGenerations);

  const running = createRunningTurn(db, {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    actorId: input.actor.userId,
    instruction: input.instruction,
    sourceContent: draft.content,
  });

  try {
    const campaign = draft.campaignId
      ? getCampaign(db, input.workspaceId, draft.campaignId)
      : undefined;
    const persona = draft.personaId
      ? getPersona(db, input.workspaceId, draft.personaId)
      : undefined;
    const signal = draft.sourceSignalId
      ? getSignal(db, input.workspaceId, draft.sourceSignalId)
      : undefined;
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      input.workspaceId,
      {
        taskType: draft.taskType,
        channel: draft.channel,
        campaignObjective: campaign?.objective,
      },
      true,
    );
    const { docs } = getBrain(db, input.workspaceId);
    const contents = Object.fromEntries(
      docs.map((document) => [document.docType, document.content]),
    ) as BrainContents;
    const channelGuidance = resolveChannelGuidance(db, input.workspaceId, draft.channel, {
      personaId: draft.personaId,
      campaignId: draft.campaignId,
    });
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: draft.taskType,
      channel: draft.channel,
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: persona ? toResolvePersona(persona) : undefined,
      campaign: campaign ? composeResolveCampaign(campaign) : undefined,
      account: resolveDraftAccount(db, input.workspaceId, {
        personaId: draft.personaId,
        channel: draft.channel,
      }),
      signal: signal
        ? { content: signal.content, source: signal.source, sourceUrl: signal.sourceUrl }
        : undefined,
      ...selectiveContextInputs(db, input.workspaceId),
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
    });
    const contextSections = normalizeContextSections(
      resolved.sections,
      evidenceDocumentLookup(db, input.workspaceId),
    );
    const result = await llm.generate({
      prompt: revisionPrompt(
        resolved.prompt,
        listRevisionTurns(db, input.workspaceId, input.draftId),
        draft.content,
        input.instruction,
      ),
    });
    const content = result.text.trim();
    const contentValidation = editDraftInputSchema.safeParse({ content });
    if (!contentValidation.success) {
      throw new RevisionFailedError(
        contentValidation.error.issues.map((issue) => issue.message).join("; "),
      );
    }
    if (isAdCreativeTaskType(draft.taskType)) {
      const validation = validateAdCreative(draft.taskType, content);
      if (!validation.ok) {
        throw new RevisionFailedError(validation.violations.map((item) => item.message).join(" "));
      }
    }

    const current = getDraft(db, input.workspaceId, input.draftId);
    if (!current || current.updatedAt !== draft.updatedAt || current.state !== draft.state) {
      throw new DraftChangedError();
    }
    return db.transaction((tx) => {
      const updated = applyDraftActionInTransaction(tx, current, "edit", input.actor, content);
      const turn = completeTurn(
        tx,
        input.workspaceId,
        running.id,
        {
          resultContent: content,
          contextSections,
          model: result.model,
          provider: result.provider,
          durationMs: result.durationMs,
        },
      );
      return { draft: updated, turn };
    });
  } catch (error) {
    failTurn(
      db,
      input.workspaceId,
      running.id,
      error instanceof Error ? error.message : String(error),
    );
    if (error instanceof DraftChangedError || error instanceof RevisionFailedError) throw error;
    throw new RevisionFailedError(error instanceof Error ? error.message : String(error));
  }
}
