"use client";
// apps/web/src/components/copilot/copilot.tsx — Sprint 42, rebuilt in Sprint 76.
// A global GTM working conversation as a right-side slide-over. Launched from
// the workspace nav; talks to /workspaces/:id/chat/* and degrades to a friendly
// "unavailable" panel if those routes 404.
//
// Sprint 76: answers STREAM. The turn is an agent_run, so tool calls appear as
// they run and every answer links to its trace in the Agent Inspector. Still
// read-only — it answers and it plans, it changes nothing (Sprint 78 adds the
// write half through the same governed propose-tools every other agent uses).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AgentStopReason,
  ChatCitation,
  ChatCitationKind,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatTurnResult,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { readChatStream } from "@/lib/chat-stream";
import {
  agentRunHref,
  citationHref,
  formatCost,
  stopReasonNote,
  threadBudgetView,
  threadTitle,
  visibleMessages as filterVisible,
} from "@/lib/chat-thread-view";
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
  "I want to launch a campaign for our new product — where do we start?",
  "Why did our LinkedIn engagement drop last month?",
  "What's working across our campaigns right now?",
];

/** Citation kind → icon within the shared vocabulary (brain=book, evidence=file, data=chart). */
const CITATION_ICON: Record<ChatCitationKind, IconName> = {
  brain: "doc-history",
  evidence: "blog",
  data: "status-learning",
};

/** What the assistant is doing right now, assembled from the stream. */
interface LiveTurn {
  text: string;
  tools: { callId: string; name: string; done: boolean; ok: boolean }[];
}

const EMPTY_TURN: LiveTurn = { text: "", tools: [] };

export function Copilot({ workspaceId, open, onClose }: CopilotProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [pending, setPending] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<LiveTurn>(EMPTY_TURN);
  const [notice, setNotice] = useState<string | null>(null);
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

  // Load threads the first time the drawer opens (and whenever the workspace changes).
  useEffect(() => {
    if (open) void loadSessions();
  }, [open, loadSessions]);

  // Load the active thread's transcript when it changes.
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

  // Keep the thread pinned to the newest content — including each delta.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live, pending]);

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
      setNotice(null);
      return session.id;
    } catch {
      setUnavailable(true);
      return null;
    }
  }

  async function deleteSession(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeId === sessionId) {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setActiveId(remaining[0]?.id ?? null);
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
    setNotice(null);
    // Optimistic user bubble so the composer feels instant.
    setMessages((prev) => [...prev, optimisticUser(sessionId!, workspaceId, message)]);
    setPending(true);
    setLive(EMPTY_TURN);

    try {
      const res = await apiFetch(`${base}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      if (res.status === 409 || res.status === 402) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setNotice(
          body.message ??
            (res.status === 402
              ? "This workspace has reached its plan's usage limit."
              : "This conversation has reached its limit. Start a new one."),
        );
        return;
      }
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          errorBubble(sessionId!, workspaceId, "Something went wrong answering that. Please try again."),
        ]);
        return;
      }

      // Non-streaming fallback: a proxy stripped the SSE content type.
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        const turn: ChatTurnResult = await res.json();
        setMessages((prev) => [...prev, turn.message]);
        void loadSessions();
        return;
      }

      let settled = false;
      await readChatStream(res, (event) => {
        switch (event.type) {
          case "text_delta":
            setLive((prev) => ({ ...prev, text: prev.text + event.text }));
            break;
          case "tool_call_start":
            setLive((prev) => ({
              ...prev,
              tools: [...prev.tools, { callId: event.callId, name: event.name, done: false, ok: true }],
            }));
            break;
          case "tool_call_end":
            setLive((prev) => ({
              ...prev,
              tools: prev.tools.map((t) =>
                t.callId === event.callId ? { ...t, done: true, ok: event.ok } : t,
              ),
            }));
            break;
          case "message":
            settled = true;
            // The persisted message replaces the live transcript: it carries
            // the citations, the run id and the cost the stream did not.
            setMessages((prev) => [...prev, event.message]);
            setLive(EMPTY_TURN);
            break;
          case "error":
            settled = true;
            setMessages((prev) => [...prev, errorBubble(sessionId!, workspaceId, event.message)]);
            setLive(EMPTY_TURN);
            break;
          default:
            break;
        }
      });

      // A stream that dropped before its `message` frame left a fully persisted
      // transcript on the server — refetch rather than trusting the partial.
      if (!settled) await loadSession(sessionId);
      // Refresh the list so an auto-generated title and the thread cost show up.
      void loadSessions();
    } catch {
      setMessages((prev) => [
        ...prev,
        errorBubble(sessionId!, workspaceId, "Couldn't reach the assistant. Check your connection and try again."),
      ]);
    } finally {
      setPending(false);
      setLive(EMPTY_TURN);
    }
  }

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const budget = activeSession ? threadBudgetView(activeSession) : null;
  const shown = filterVisible(messages);

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="Assistant">
        <header className={styles.head}>
          <h2 className={styles.headTitle}>
            <Icon name="brain" size="standard" />
            Assistant
          </h2>
          <div className={styles.headSpacer} />
          {!unavailable && (
            <IconButton
              label="New conversation"
              className={styles.iconBtn}
              onClick={() => void createSession()}
            >
              <Icon name="add" size="compact" />
            </IconButton>
          )}
          <IconButton label="Close assistant" className={styles.iconBtn} onClick={onClose}>
            <Icon name="close" size="compact" />
          </IconButton>
        </header>

        {unavailable ? (
          <div className={styles.unavailable}>
            <Icon name="info" size="emphasized" />
            <p className={styles.emptyText}>
              The assistant isn&apos;t available yet. It&apos;ll turn on once the chat service is deployed for
              this workspace.
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
                <span className={styles.sessionToggleLabel}>
                  {activeSession ? threadTitle(activeSession) : "New conversation"}
                </span>
                <span className={styles.sessionToggleHint}>
                  {activeSession && activeSession.totalCostCents > 0
                    ? formatCost(activeSession.totalCostCents)
                    : `${sessions.length} ${sessions.length === 1 ? "thread" : "threads"}`}
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
                          {threadTitle(s)}
                        </button>
                        <IconButton
                          label="Delete conversation"
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

            {activeSession?.goal.trim() && (
              <div className={styles.scopeBar}>
                <Icon name="status-learning" size="compact" />
                <span className={styles.scopeGoal}>{activeSession.goal}</span>
              </div>
            )}

            {(notice ?? budget?.warning) && (
              <p className={styles.notice}>
                <Icon name="info" size="compact" />
                {notice ?? budget?.warning}
              </p>
            )}

            <div className={styles.thread} ref={threadRef}>
              {shown.length === 0 && !pending ? (
                <div className={styles.empty}>
                  <span className={styles.emptyIcon}>
                    <Icon name="brain" size="emphasized" />
                  </span>
                  <div>
                    <h3 className={styles.emptyTitle}>Work through a GTM problem</h3>
                    <p className={styles.emptyText}>
                      Grounded in your brain, evidence and live data. It asks what it needs and shows its
                      sources — and it&apos;s read-only, so it changes nothing.
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
                  {shown.map((m) =>
                    m.role === "compaction" ? (
                      <div key={m.id} className={styles.compaction}>
                        <Icon name="doc-history" size="compact" />
                        <span>Earlier turns summarized to stay within the context budget.</span>
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
                          {m.role === "assistant" && (
                            <AssistantFooter
                              message={m}
                              workspaceId={workspaceId}
                              stopNote={stopReasonNote(m.stopReason)}
                            />
                          )}
                        </div>
                      </div>
                    ),
                  )}
                  {pending && (
                    <div className={`${styles.row} ${styles.rowAssistant}`}>
                      <div>
                        {live.tools.map((t) => (
                          <div key={t.callId} className={styles.toolLine}>
                            <Icon
                              name={t.done ? (t.ok ? "approve" : "reject") : "status-generating"}
                              size="compact"
                            />
                            {t.done ? "read" : "reading"} {t.name.replace(/_/g, " ")}
                          </div>
                        ))}
                        {live.text ? (
                          <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>{live.text}</div>
                        ) : (
                          <div className={styles.pending}>
                            <Icon name="status-generating" size="compact" />
                            Thinking…
                          </div>
                        )}
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
                placeholder="What are you trying to do?"
                value={draft}
                rows={1}
                disabled={pending || budget?.exhausted}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <Button
                type="submit"
                variant="primary"
                loading={pending}
                disabled={!draft.trim() || budget?.exhausted}
              >
                <Icon name="send" size="compact" />
              </Button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}

/** Citations, the trace link and the per-turn cost — everything under an answer. */
function AssistantFooter({
  message,
  workspaceId,
  stopNote,
}: {
  message: ChatMessage;
  workspaceId: string;
  stopNote: string | null;
}) {
  const hasFooter =
    message.citations.length > 0 || message.agentRunId !== null || stopNote !== null;
  if (!hasFooter) return null;

  return (
    <>
      {message.citations.length > 0 && (
        <div className={styles.citations}>
          {message.citations.map((c, i) => (
            <CitationChip key={`${message.id}-${i}`} citation={c} workspaceId={workspaceId} />
          ))}
        </div>
      )}
      <div className={styles.turnMeta}>
        {stopNote && <span className={styles.turnStop}>{stopNote}</span>}
        {message.agentRunId && (
          <Link className={styles.reviewLink} href={agentRunHref(workspaceId, message.agentRunId)}>
            <Icon name="status-learning" size="compact" />
            How it answered
          </Link>
        )}
        {message.costCents > 0 && (
          <span className={styles.turnCost}>{formatCost(message.costCents)}</span>
        )}
      </div>
    </>
  );
}

function CitationChip({ citation, workspaceId }: { citation: ChatCitation; workspaceId: string }) {
  const href = citationHref(citation, workspaceId);
  const title = citation.detail ?? `${citation.kind}: ${citation.ref}`;
  const body = (
    <>
      <Icon name={CITATION_ICON[citation.kind]} size="compact" />
      <span className={styles.chipLabel}>{citation.label}</span>
    </>
  );
  // A chip with no route renders unlinked rather than navigating somewhere wrong.
  if (!href) {
    return (
      <span className={styles.chip} title={title}>
        {body}
      </span>
    );
  }
  const external = /^https?:\/\//.test(href);
  return external ? (
    <a className={styles.chip} title={title} href={href} target="_blank" rel="noreferrer noopener">
      {body}
    </a>
  ) : (
    <Link className={styles.chip} title={title} href={href}>
      {body}
    </Link>
  );
}

function bubble(
  sessionId: string,
  workspaceId: string,
  role: "user" | "assistant",
  content: string,
): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    workspaceId,
    role,
    content,
    toolName: null,
    citations: [],
    agentRunId: null,
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    stopReason: null as AgentStopReason | null,
    createdAt: Date.now(),
  };
}

function optimisticUser(sessionId: string, workspaceId: string, content: string): ChatMessage {
  return bubble(sessionId, workspaceId, "user", content);
}

function errorBubble(sessionId: string, workspaceId: string, content: string): ChatMessage {
  return bubble(sessionId, workspaceId, "assistant", content);
}
