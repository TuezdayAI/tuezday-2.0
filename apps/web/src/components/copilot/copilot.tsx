"use client";
// apps/web/src/components/copilot/copilot.tsx — Sprint 42 Part 1.
// A global, read-only grounded copilot as a right-side slide-over. Launched
// from the workspace nav; talks to /workspaces/:id/chat/* and degrades to a
// friendly "unavailable" panel if those routes 404 (API not deployed yet).
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatCitation,
  ChatCitationKind,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatTurnResult,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { Button, IconButton } from "@/src/components/ui/button";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { Textarea } from "@/src/components/ui/input";
import styles from "./copilot.module.css";

interface CopilotProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

const EXAMPLE_QUESTIONS = [
  "Summarize our ICP",
  "Which sequence has the best reply rate?",
  "What should I focus on?",
];

/** Citation kind → icon within the shared vocabulary (brain=book, evidence=file, data=chart). */
const CITATION_ICON: Record<ChatCitationKind, IconName> = {
  brain: "doc-history",
  evidence: "blog",
  data: "status-learning",
};

export function Copilot({ workspaceId, open, onClose }: CopilotProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [pending, setPending] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const base = `/workspaces/${workspaceId}/chat`;

  const loadSession = useCallback(
    async (sessionId: string) => {
      try {
        const res = await apiFetch(`${base}/sessions/${sessionId}`);
        if (!res.ok) {
          setMessages([]);
          return;
        }
        const detail: ChatSessionDetail = await res.json();
        setMessages(detail.messages ?? []);
      } catch {
        setMessages([]);
      }
    },
    [base],
  );

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await apiFetch(`${base}/sessions`);
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      if (!res.ok) return;
      const list: ChatSession[] = await res.json();
      setUnavailable(false);
      setSessions(list);
      setActiveId((current) => {
        if (current && list.some((s) => s.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch {
      // Network error — treat as unavailable rather than crashing the page.
      setUnavailable(true);
    } finally {
      setLoadingSessions(false);
    }
  }, [base]);

  // Load sessions the first time the drawer opens (and whenever the workspace changes).
  useEffect(() => {
    if (open) void loadSessions();
  }, [open, loadSessions]);

  // Load the active session's thread when it changes.
  useEffect(() => {
    if (open && activeId) void loadSession(activeId);
    if (!activeId) setMessages([]);
  }, [open, activeId, loadSession]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Keep the thread pinned to the newest message.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  async function createSession(): Promise<string | null> {
    try {
      const res = await apiFetch(`${base}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 404) {
        setUnavailable(true);
        return null;
      }
      if (!res.ok) return null;
      const session: ChatSession = await res.json();
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      setMessages([]);
      return session.id;
    } catch {
      setUnavailable(true);
      return null;
    }
  }

  async function deleteSession(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeId === sessionId) {
      setActiveId((prev) => {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        return remaining[0]?.id ?? null;
      });
    }
    try {
      await apiFetch(`${base}/sessions/${sessionId}`, { method: "DELETE" });
    } catch {
      // Best effort — the row is already gone from the UI.
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;

    let sessionId = activeId;
    if (!sessionId) {
      sessionId = await createSession();
      if (!sessionId) return;
    }

    setDraft("");
    // Optimistic user bubble so the composer feels instant.
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      sessionId,
      workspaceId,
      role: "user",
      content: message,
      toolName: null,
      citations: [],
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setPending(true);
    try {
      const res = await apiFetch(`${base}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          errorBubble(sessionId!, workspaceId, "Something went wrong answering that. Please try again."),
        ]);
        return;
      }
      const turn: ChatTurnResult = await res.json();
      // Re-sync from the server so persisted tool messages + ids are authoritative.
      await loadSession(sessionId);
      // Refresh the session list so an auto-generated title shows up.
      void loadSessions();
      // Fallback: if the reload returned nothing, append the answer we have.
      setMessages((prev) => {
        if (prev.some((m) => m.role === "assistant" && m.content === turn.answer)) return prev;
        if (prev[prev.length - 1]?.role === "assistant") return prev;
        return [...prev, assistantBubble(sessionId!, workspaceId, turn.answer, turn.citations)];
      });
    } catch {
      setMessages((prev) => [
        ...prev,
        errorBubble(sessionId!, workspaceId, "Couldn't reach the copilot. Check your connection and try again."),
      ]);
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeTitle = activeSession?.title?.trim() || "New chat";
  const visibleMessages = messages.filter((m) => m.role !== "tool" || m.toolName);

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="Copilot">
        <header className={styles.head}>
          <h2 className={styles.headTitle}>
            <Icon name="brain" size="standard" />
            Copilot
          </h2>
          <div className={styles.headSpacer} />
          {!unavailable && (
            <IconButton label="New chat" className={styles.iconBtn} onClick={() => void createSession()}>
              <Icon name="add" size="compact" />
            </IconButton>
          )}
          <IconButton label="Close copilot" className={styles.iconBtn} onClick={onClose}>
            <Icon name="close" size="compact" />
          </IconButton>
        </header>

        {unavailable ? (
          <div className={styles.unavailable}>
            <Icon name="info" size="emphasized" />
            <p className={styles.emptyText}>
              The copilot isn&apos;t available yet. It&apos;ll turn on once the chat service is deployed for this
              workspace.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.sessionBar}>
              <button
                type="button"
                className={styles.sessionToggle}
                onClick={() => setShowSessions((v) => !v)}
                aria-expanded={showSessions}
              >
                <Icon name="chevron-down" size="compact" />
                <span className={styles.sessionToggleLabel}>{activeTitle}</span>
                <span className={styles.sessionToggleHint}>
                  {sessions.length} {sessions.length === 1 ? "chat" : "chats"}
                </span>
              </button>
              {showSessions && (
                <div className={styles.sessionPanel}>
                  {loadingSessions && sessions.length === 0 ? (
                    <div className={styles.sessionEmpty}>Loading…</div>
                  ) : sessions.length === 0 ? (
                    <div className={styles.sessionEmpty}>No conversations yet.</div>
                  ) : (
                    sessions.map((s) => (
                      <div key={s.id} className={styles.sessionRow}>
                        <button
                          type="button"
                          className={`${styles.sessionSelect} ${s.id === activeId ? styles.sessionSelectActive : ""}`}
                          onClick={() => {
                            setActiveId(s.id);
                            setShowSessions(false);
                          }}
                        >
                          {s.title?.trim() || "New chat"}
                        </button>
                        <IconButton
                          label="Delete chat"
                          size="compact"
                          className={styles.iconBtn}
                          onClick={() => void deleteSession(s.id)}
                        >
                          <Icon name="reject" size="compact" />
                        </IconButton>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className={styles.thread} ref={threadRef}>
              {visibleMessages.length === 0 && !pending ? (
                <div className={styles.empty}>
                  <span className={styles.emptyIcon}>
                    <Icon name="brain" size="emphasized" />
                  </span>
                  <div>
                    <h3 className={styles.emptyTitle}>Ask your GTM copilot</h3>
                    <p className={styles.emptyText}>
                      Grounded in your brain, evidence, and live data. It&apos;s read-only — it answers, it
                      doesn&apos;t change anything.
                    </p>
                  </div>
                  <div className={styles.examples}>
                    {EXAMPLE_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className={styles.example}
                        disabled={pending}
                        onClick={() => void send(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {visibleMessages.map((m) =>
                    m.role === "tool" ? (
                      <div key={m.id} className={styles.toolLine}>
                        <Icon name="status-generating" size="compact" />
                        used {m.toolName}
                      </div>
                    ) : (
                      <div
                        key={m.id}
                        className={`${styles.row} ${m.role === "user" ? styles.rowUser : styles.rowAssistant}`}
                      >
                        <div>
                          <div
                            className={`${styles.bubble} ${
                              m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant
                            }`}
                          >
                            {m.content}
                          </div>
                          {m.role === "assistant" && m.citations.length > 0 && (
                            <div className={styles.citations}>
                              {m.citations.map((c, i) => (
                                <CitationChip key={`${m.id}-${i}`} citation={c} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ),
                  )}
                  {pending && (
                    <div className={`${styles.row} ${styles.rowAssistant}`}>
                      <div className={styles.pending}>
                        <Icon name="status-generating" size="compact" />
                        Thinking…
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <form
              className={styles.composer}
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <Textarea
                className={styles.composerField}
                placeholder="Ask about your GTM…"
                value={draft}
                rows={1}
                disabled={pending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <Button type="submit" variant="primary" loading={pending} disabled={!draft.trim()}>
                <Icon name="send" size="compact" />
              </Button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}

function CitationChip({ citation }: { citation: ChatCitation }) {
  return (
    <span className={styles.chip} title={citation.detail ?? `${citation.kind}: ${citation.ref}`}>
      <Icon name={CITATION_ICON[citation.kind]} size="compact" />
      <span className={styles.chipLabel}>{citation.label}</span>
    </span>
  );
}

function assistantBubble(
  sessionId: string,
  workspaceId: string,
  content: string,
  citations: ChatCitation[],
): ChatMessage {
  return {
    id: `answer-${Date.now()}`,
    sessionId,
    workspaceId,
    role: "assistant",
    content,
    toolName: null,
    citations,
    createdAt: Date.now(),
  };
}

function errorBubble(sessionId: string, workspaceId: string, content: string): ChatMessage {
  return assistantBubble(sessionId, workspaceId, content, []);
}
