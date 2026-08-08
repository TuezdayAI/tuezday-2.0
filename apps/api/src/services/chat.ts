import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  CHAT_THREAD_TOKEN_CAP,
  type AgentStopReason,
  type Channel,
  type ChatCard,
  type ChatCitation,
  type ChatMessage,
  type ChatMessageRole,
  type ChatSession,
  type CreateChatSessionInput,
  type UpdateChatSessionInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { chatMessages, chatSessions, type ChatMessageRow, type ChatSessionRow } from "../db/schema";

// ---------------------------------------------------------------------------
// Thread + transcript persistence (Sprint 42, extended Sprint 76).
//
// Thin DB layer shared by the routes and the turn service. No LLM call, no
// tool dispatch and no policy lives here — this module only reads and writes
// rows, which is what lets the turn service stay a testable unit.
// ---------------------------------------------------------------------------

export function rowToSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    title: row.title,
    goal: row.goal,
    campaignId: row.campaignId,
    personaId: row.personaId,
    channel: (row.channel as Channel | null) ?? null,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCostCents: row.totalCostCents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Parse a stored JSON array defensively — a bad blob never breaks a read. */
function parseArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function rowToMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    role: row.role as ChatMessageRole,
    content: row.content,
    toolName: row.toolName ?? null,
    citations: parseArray<ChatCitation>(row.citationsJson),
    // Sprint 77: the typed result cards this turn rendered.
    cards: parseArray<ChatCard>(row.cardsJson),
    agentRunId: row.agentRunId ?? null,
    costCents: row.costCents,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    stopReason: (row.stopReason as AgentStopReason | null) ?? null,
    producedRef: row.producedRef ?? null,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export async function createSession(
  db: Db,
  workspaceId: string,
  userId: string | null,
  input: CreateChatSessionInput,
): Promise<ChatSession> {
  const now = Date.now();
  const row: ChatSessionRow = {
    id: randomUUID(),
    workspaceId,
    userId,
    title: (input.title ?? "").trim(),
    goal: (input.goal ?? "").trim(),
    campaignId: input.campaignId ?? null,
    personaId: input.personaId ?? null,
    channel: input.channel ?? null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostCents: 0,
    compactedThroughMessageId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(chatSessions).values(row);
  return rowToSession(row);
}

/** Threads for a workspace, newest activity first. */
export async function listSessions(db: Db, workspaceId: string): Promise<ChatSession[]> {
  return (await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId))
    .orderBy(desc(chatSessions.updatedAt)))
    .map(rowToSession);
}

/** A single workspace-scoped thread, or undefined if missing / cross-workspace. */
export async function getSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSession | undefined> {
  const row = await getSessionRow(db, workspaceId, sessionId);
  return row ? rowToSession(row) : undefined;
}

export async function getSessionRow(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSessionRow | undefined> {
  return (await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.id, sessionId))))[0];
}

/**
 * Edit a thread's title, goal or scope. Scope fields are tri-state: absent
 * leaves them alone, `null` unbinds them. Changing scope changes which context
 * bundle the next turn resolves — it does not rewrite the transcript.
 */
export async function updateSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
  input: UpdateChatSessionInput,
): Promise<ChatSession | undefined> {
  const existing = await getSession(db, workspaceId, sessionId);
  if (!existing) return undefined;

  const patch: Partial<ChatSessionRow> = { updatedAt: Date.now() };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.goal !== undefined) patch.goal = input.goal.trim();
  if (input.campaignId !== undefined) patch.campaignId = input.campaignId;
  if (input.personaId !== undefined) patch.personaId = input.personaId;
  if (input.channel !== undefined) patch.channel = input.channel;

  await db.update(chatSessions).set(patch).where(eq(chatSessions.id, sessionId));
  return await getSession(db, workspaceId, sessionId);
}

/** Set the title once, when a thread has none — auto-titling never overwrites. */
export async function setSessionTitleIfEmpty(db: Db, sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  await db.update(chatSessions)
    .set({ title: trimmed })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.title, "")));
}

/** Set the goal once, when a thread has none (D-76.12). */
export async function setSessionGoalIfEmpty(db: Db, sessionId: string, goal: string): Promise<void> {
  const trimmed = goal.trim();
  if (!trimmed) return;
  await db.update(chatSessions)
    .set({ goal: trimmed })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.goal, "")));
}

export interface ThreadUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

/**
 * Add one run's usage to the thread's lifetime totals. Every model call a turn
 * makes — the answer, the auto-title, a compaction — passes through here, so
 * the cap counts everything the thread cost, not just its visible answers.
 */
export async function addSessionUsage(db: Db, sessionId: string, usage: ThreadUsage): Promise<void> {
  await db.update(chatSessions)
    .set({
      totalInputTokens: sql`${chatSessions.totalInputTokens} + ${usage.inputTokens}`,
      totalOutputTokens: sql`${chatSessions.totalOutputTokens} + ${usage.outputTokens}`,
      totalCostCents: sql`${chatSessions.totalCostCents} + ${usage.costCents}`,
      updatedAt: Date.now(),
    })
    .where(eq(chatSessions.id, sessionId));
}

export function threadTokens(session: Pick<ChatSession, "totalInputTokens" | "totalOutputTokens">): number {
  return session.totalInputTokens + session.totalOutputTokens;
}

/**
 * Whether the thread has spent its hard lifetime budget (D-76.4). Checked
 * before a turn starts: a turn that begins is allowed to finish, because
 * killing a run mid-flight would leave a half-answer the founder paid for.
 */
export function isThreadBudgetExhausted(session: ChatSession): boolean {
  return threadTokens(session) >= CHAT_THREAD_TOKEN_CAP;
}

export async function setCompactedThrough(db: Db, sessionId: string, messageId: string): Promise<void> {
  await db.update(chatSessions)
    .set({ compactedThroughMessageId: messageId })
    .where(eq(chatSessions.id, sessionId));
}

export async function deleteSession(db: Db, workspaceId: string, sessionId: string): Promise<boolean> {
  const existing = await getSession(db, workspaceId, sessionId);
  if (!existing) return false;
  // chat_messages cascade on session delete (FK onDelete: cascade).
  await db.delete(chatSessions)
    .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.id, sessionId)));
  return true;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Ordered transcript for a thread, in strict insertion order. Several messages
 * in one turn (user → tool → assistant) can share a millisecond `createdAt`, so
 * we tie-break on the insertion-order `seq` rather than the random uuid PK.
 */
export async function listMessages(db: Db, sessionId: string): Promise<ChatMessage[]> {
  return (await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.seq)))
    .map(rowToMessage);
}

/**
 * The messages a turn actually sends to the model: everything after the latest
 * compaction, with the compaction summary itself at the head. Before any
 * compaction this is the whole transcript.
 */
export async function listActiveMessages(
  db: Db,
  sessionId: string,
  compactedThroughMessageId: string | null,
): Promise<ChatMessage[]> {
  const all = await listMessages(db, sessionId);
  if (!compactedThroughMessageId) return all;
  const cutoff = all.findIndex((m) => m.id === compactedThroughMessageId);
  // A cutoff we cannot find means the marker is stale (the message was
  // deleted); replaying the full transcript is the safe degradation.
  if (cutoff < 0) return all;
  const after = all.slice(cutoff + 1);
  const summary = all.filter((m) => m.role === "compaction").at(-1);
  return summary ? [summary, ...after.filter((m) => m.id !== summary.id)] : after;
}

export interface AppendMessageInput {
  role: ChatMessageRole;
  content: string;
  toolName?: string | null;
  citations?: ChatCitation[];
  /** The records this turn surfaced, rendered as cards (Sprint 77). */
  cards?: ChatCard[];
  /** The agent_run behind this assistant turn (Sprint 76). */
  agentRunId?: string | null;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: AgentStopReason | null;
  /** What a confirmed proposal produced (Sprint 78) — `draft:<id>` etc. */
  producedRef?: string | null;
}

/** Persist one message and bump the thread's updatedAt so lists resort. */
export async function appendMessage(
  db: Db,
  workspaceId: string,
  sessionId: string,
  input: AppendMessageInput,
): Promise<ChatMessage> {
  const now = Date.now();
  // `seq` is assigned by the database (it breaks same-millisecond ties in
  // transcript order), so the row is written as an insert and read back.
  const row: typeof chatMessages.$inferInsert = {
    id: randomUUID(),
    sessionId,
    workspaceId,
    role: input.role,
    content: input.content,
    toolName: input.toolName ?? null,
    citationsJson: JSON.stringify(input.citations ?? []),
    cardsJson: JSON.stringify(input.cards ?? []),
    // Sprint 78 keeps `proposal_json` dormant: a chat proposal is its own row
    // now (chat_proposals), because its status changes after the message is
    // written and a transcript row should not be rewritten by a click.
    proposalJson: null,
    producedRef: input.producedRef ?? null,
    agentRunId: input.agentRunId ?? null,
    costCents: input.costCents ?? 0,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    stopReason: input.stopReason ?? null,
    createdAt: now,
  };
  const inserted = (await db.insert(chatMessages).values(row).returning())[0]!;
  await db.update(chatSessions).set({ updatedAt: now }).where(eq(chatSessions.id, sessionId));
  return rowToMessage(inserted);
}
