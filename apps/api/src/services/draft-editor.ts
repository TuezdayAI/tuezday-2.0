import { and, asc, eq, ne } from "drizzle-orm";
import {
  draftEditorContextSchema,
  publicationSchema,
  type DraftEditorContext,
  type EditorContextSection,
  type EditorEvidenceCitation,
} from "@tuezday/contracts";
import type { ContextSection } from "@tuezday/brain";
import type { Db } from "../db";
import { drafts, evidenceDocuments, generations } from "../db/schema";
import { getCurrentCampaignPlan } from "./campaign-plans";
import { getCampaign } from "./campaigns";
import { listConnections, providerByKey } from "./connections";
import { getDraft, listDecisions } from "./drafts";
import { listRevisionTurns } from "./draft-revisions";
import { listExecutionResults } from "./executions";
import { getPersona } from "./personas";
import {
  providerForSocialChannel,
  resolvePersonaSocialConnection,
} from "./persona-social-accounts";
import { listPublications } from "./publications";

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
  const evidenceByR2rId = new Map(
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
          ? [[row.r2rDocumentId, { title: row.title, kind: row.kind, sourceRef: row.sourceRef }] as const]
          : [],
      ),
  );
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
  });
}
