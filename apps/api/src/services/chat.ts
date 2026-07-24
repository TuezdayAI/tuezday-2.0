import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type {
  ChatCitation,
  ChatMessage,
  ChatMessageRole,
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

export function rowToMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    role: row.role as ChatMessageRole,
    content: row.content,
    toolName: row.toolName ?? null,
    citations: parseCitations(row.citationsJson),
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
    createdAt: now,
  };
  db.insert(chatMessages).values(row).run();
  db.update(chatSessions).set({ updatedAt: now }).where(eq(chatSessions.id, sessionId)).run();
  return rowToMessage(row);
}
