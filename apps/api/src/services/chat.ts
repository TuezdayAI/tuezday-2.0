import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type {
  ChatCitation,
  ChatMessage,
  ChatMessageRole,
  ChatProposal,
  ChatSession,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { chatMessages, chatSessions, type ChatMessageRow, type ChatSessionRow } from "../db/schema";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

export function rowToSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Parse the stored citations JSON defensively — a bad blob never breaks a read. */
function parseCitations(json: string): ChatCitation[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ChatCitation[]) : [];
  } catch {
    return [];
  }
}

/**
 * The stored proposal blob wraps the client-facing `ChatProposal` together with
 * the commit `args` (server-only — never surfaced in the ChatMessage contract).
 */
interface StoredProposal {
  proposal: ChatProposal;
  args: Record<string, unknown>;
}

/** Parse a stored proposal blob defensively — a bad blob reads as no proposal. */
function parseStoredProposal(json: string | null): StoredProposal | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    // Wrapper shape { proposal, args }; tolerate a legacy bare ChatProposal.
    if ("proposal" in parsed && typeof (parsed as StoredProposal).proposal === "object") {
      const w = parsed as StoredProposal;
      return { proposal: w.proposal, args: w.args ?? {} };
    }
    return { proposal: parsed as ChatProposal, args: {} };
  } catch {
    return null;
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
    citations: parseCitations(row.citationsJson),
    proposal: parseStoredProposal(row.proposalJson)?.proposal ?? null,
    producedRef: row.producedRef ?? null,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(
  db: Db,
  workspaceId: string,
  userId: string | null,
  title: string,
): ChatSession {
  const now = Date.now();
  const row: ChatSessionRow = {
    id: randomUUID(),
    workspaceId,
    userId,
    title: title.trim(),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(chatSessions).values(row).run();
  return rowToSession(row);
}

/** Sessions for a workspace, newest activity first. */
export function listSessions(db: Db, workspaceId: string): ChatSession[] {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId))
    .orderBy(desc(chatSessions.updatedAt))
    .all()
    .map(rowToSession);
}

/** A single workspace-scoped session, or undefined if missing / cross-workspace. */
export function getSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
): ChatSession | undefined {
  const row = db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.id, sessionId)))
    .get();
  return row ? rowToSession(row) : undefined;
}

/**
 * Ordered transcript for a session, in strict insertion order. Several messages
 * in one turn (user → tool → assistant) can share a millisecond `createdAt`, so
 * we tie-break on the implicit rowid rather than the random uuid PK.
 */
export function listMessages(db: Db, sessionId: string): ChatMessage[] {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(sql`${chatMessages}.rowid asc`)
    .all()
    .map(rowToMessage);
}

export interface PendingProposal {
  messageId: string;
  proposal: ChatProposal;
  /** Server-only commit args (not part of the ChatMessage contract). */
  args: Record<string, unknown>;
}

/**
 * The session's pending proposal, if any (Sprint 42 P2). A proposal is pending
 * iff the latest ASSISTANT message carries one. Committing or discarding, or a
 * normal answer, appends a later assistant message and thereby retires it — but
 * a trailing user message (e.g. a plain-text "yes") does NOT, so the confirm
 * can still find the proposal it is answering.
 */
export function getPendingProposal(db: Db, sessionId: string): PendingProposal | null {
  const row = db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, "assistant")))
    .orderBy(sql`${chatMessages}.rowid desc`)
    .limit(1)
    .get();
  if (!row || !row.proposalJson) return null;
  const stored = parseStoredProposal(row.proposalJson);
  if (!stored) return null;
  return { messageId: row.id, proposal: stored.proposal, args: stored.args };
}

export function deleteSession(db: Db, workspaceId: string, sessionId: string): boolean {
  const existing = getSession(db, workspaceId, sessionId);
  if (!existing) return false;
  // chat_messages cascade on session delete (FK onDelete: cascade).
  db.delete(chatSessions)
    .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.id, sessionId)))
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AppendMessageInput {
  role: ChatMessageRole;
  content: string;
  toolName?: string | null;
  citations?: ChatCitation[];
  /** A pending proposal offered by this message (Sprint 42 P2). */
  proposal?: ChatProposal | null;
  /** Server-only commit args stored alongside the proposal (never surfaced). */
  proposalArgs?: Record<string, unknown> | null;
  /** A ref to the gated item this message created, once committed. */
  producedRef?: string | null;
}

/** Persist one message and bump the session's updatedAt so lists resort. */
export function appendMessage(
  db: Db,
  workspaceId: string,
  sessionId: string,
  input: AppendMessageInput,
): ChatMessage {
  const now = Date.now();
  const row: ChatMessageRow = {
    id: randomUUID(),
    sessionId,
    workspaceId,
    role: input.role,
    content: input.content,
    toolName: input.toolName ?? null,
    citationsJson: JSON.stringify(input.citations ?? []),
    proposalJson: input.proposal
      ? JSON.stringify({ proposal: input.proposal, args: input.proposalArgs ?? {} })
      : null,
    producedRef: input.producedRef ?? null,
    createdAt: now,
  };
  db.insert(chatMessages).values(row).run();
  db.update(chatSessions).set({ updatedAt: now }).where(eq(chatSessions.id, sessionId)).run();
  return rowToMessage(row);
}
