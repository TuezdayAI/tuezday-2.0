"use client";
// apps/web/src/components/copilot/copilot.tsx — Sprint 42, rebuilt in Sprint 76.
// A global GTM working conversation as a right-side slide-over. Launched from
// the workspace nav; talks to /workspaces/:id/chat/* and degrades to a friendly
// "unavailable" panel if those routes 404.
//
// Sprint 76: answers STREAM. The turn is an agent_run, so tool calls appear as
// they run and every answer links to its trace in the Agent Inspector.
//
// Sprint 78: it can now ACT — but only by asking. A propose call renders a
// confirmation card here; nothing reaches the approval gate or the action
// policy until the founder confirms it, and the policy tree still decides what
// happens after that.
//
// Sprint 77: records render as CARDS rather than prose, and a card's buttons
// call the same routes the dedicated pages call. Plus the command layer (`/`),
// pinned context (`@`), and a URL paste that becomes an untrusted pin.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CHAT_COMMANDS,
  parseChatCommand,
  agentTaskStreamEventSchema,
  type AgentStopReason,
  type AgentTask,
  type AgentTaskCreated,
  type AgentTaskDetail,
  type ChatCard,
  type ChatCitation,
  type ChatCitationKind,
  type ChatMessage,
  type ChatPin,
  type ChatPinKind,
  type ChatProposal,
  type ChatSession,
  type ChatSessionDetail,
  type ChatTurnResult,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  cardActionRequest,
  cardHasAction,
  cardHref,
  cardKindLabel,
  clearMention,
  commandQuery,
  mentionQuery,
  pastedUrl,
  pinKindLabel,
  pinIsUntrusted,
  pinsSummary,
} from "@/lib/chat-card-view";
import { describeDiff, diffWords, hasChanges } from "@/lib/text-diff";
import { readChatStream } from "@/lib/chat-stream";
import { readSseStream } from "@/lib/sse-stream";
import {
  applyTaskEvent,
  blockingQuestion,
  budgetWarningText,
  shouldStream,
  steersRemaining,
  subagentRows,
  taskActivity,
  taskControls,
  taskStatusDetail,
  taskStatusLabel,
  taskTone,
} from "@/lib/agent-task-view";
import {
  isActionable,
  mergeProposal,
  pendingSummary,
  producedHref,
  proposalOutcome,
  proposalTone,
  proposalsForMessage,
  quarantineWarning,
  unattachedProposals,
} from "@/lib/chat-proposal-view";
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
  "Draft a LinkedIn post about our funding and queue it to the Launch campaign",
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
  /** Cards arrive as each tool returns, so records appear mid-run. */
  cards: ChatCard[];
}

const EMPTY_TURN: LiveTurn = { text: "", tools: [], cards: [] };

/** What an `@` mention can pin, and where the picker reads its options from. */
const MENTION_SOURCES: { kind: ChatPinKind; path: string; labelKey: "name" | "content" }[] = [
  { kind: "campaign", path: "/campaigns", labelKey: "name" },
  { kind: "persona", path: "/personas", labelKey: "name" },
  { kind: "draft", path: "/drafts?state=pending_review", labelKey: "content" },
];

interface MentionOption {
  kind: ChatPinKind;
  refId: string;
  label: string;
}

export function Copilot({ workspaceId, open, onClose }: CopilotProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<ChatProposal[]>([]);
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [mentionOptions, setMentionOptions] = useState<MentionOption[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [pending, setPending] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<LiveTurn>(EMPTY_TURN);
  const [notice, setNotice] = useState<string | null>(null);
  // Sprint 79: work this thread detached. `tasks` is the list; `openTask` is
  // the one whose live panel is showing.
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const base = `/workspaces/${workspaceId}/chat`;
  const taskBase = `/workspaces/${workspaceId}/agent-tasks`;

  const loadSession = useCallback(
    async (sessionId: string) => {
      try {
        const res = await apiFetch(`${base}/sessions/${sessionId}`);
        if (!res.ok) {
          setMessages([]);
          setProposals([]);
          setPins([]);
          return;
        }
        const detail: ChatSessionDetail = await res.json();
        setMessages(detail.messages ?? []);
        setProposals(detail.proposals ?? []);
        setPins(detail.pins ?? []);
      } catch {
        setMessages([]);
        setProposals([]);
        setPins([]);
      }
    },
    [base],
  );

  /** The background tasks this thread has detached, newest first. */
  const loadTasks = useCallback(
    async (sessionId: string) => {
      try {
        const res = await apiFetch(`${taskBase}?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) return;
        const list: AgentTask[] = await res.json();
        setTasks(list);
        // Re-open the panel on whatever is still going, so reloading the page
        // mid-run does not lose sight of it.
        setOpenTaskId((current) => current ?? list.find((t) => shouldStream(t))?.id ?? null);
      } catch {
        // A tasks endpoint that is not there yet must not break the thread.
      }
    },
    [taskBase],
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
    if (open && activeId) {
      void loadSession(activeId);
      void loadTasks(activeId);
    }
    if (!activeId) {
      setMessages([]);
      setProposals([]);
      setPins([]);
      setTasks([]);
      setOpenTaskId(null);
    }
  }, [open, activeId, loadSession, loadTasks]);

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
      setProposals([]);
      setPins([]);
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

  /**
   * Pin an entity to the thread (Sprint 77). Campaign and persona pins also
   * rebind the thread's scope server-side (D-77.5), so the next turn resolves
   * against a different bundle — which is the whole point of pinning one.
   */
  async function pinEntity(kind: ChatPinKind, refId: string, label?: string) {
    if (!activeId) return;
    try {
      const res = await apiFetch(`${base}/sessions/${activeId}/pins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, refId, ...(label ? { label } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(
          body.error === "pin_limit_reached"
            ? "That's as much as one conversation can hold pinned. Remove one first."
            : body.error === "invalid_url"
              ? "That link can't be read from here."
              : "Couldn't pin that.",
        );
        return;
      }
      const pin: ChatPin = await res.json();
      setPins((prev) => (prev.some((p) => p.id === pin.id) ? prev : [...prev, pin]));
      setNotice(null);
    } catch {
      setNotice("Couldn't reach the assistant. Check your connection and try again.");
    }
  }

  async function unpin(pinId: string) {
    if (!activeId) return;
    setPins((prev) => prev.filter((p) => p.id !== pinId));
    try {
      await apiFetch(`${base}/sessions/${activeId}/pins/${pinId}`, { method: "DELETE" });
    } catch {
      // Best effort — the chip is already gone from the UI.
    }
  }

  /** Load what an `@` can pin. Fetched once per open, filtered client-side. */
  const loadMentionOptions = useCallback(async () => {
    const collected: MentionOption[] = [];
    for (const source of MENTION_SOURCES) {
      try {
        const res = await apiFetch(`/workspaces/${workspaceId}${source.path}`);
        if (!res.ok) continue;
        const rows: Record<string, unknown>[] = await res.json();
        for (const row of rows.slice(0, 20)) {
          const id = typeof row.id === "string" ? row.id : null;
          const raw = row[source.labelKey];
          if (!id || typeof raw !== "string") continue;
          collected.push({
            kind: source.kind,
            refId: id,
            label: raw.length > 60 ? `${raw.slice(0, 59)}…` : raw,
          });
        }
      } catch {
        // A source that will not load simply offers nothing to pin.
      }
    }
    setMentionOptions(collected);
  }, [workspaceId]);

  /**
   * Run an instant command (D-77.4). No model runs: the API executes registry
   * read tools and returns cards, so this costs nothing and cannot be wrong
   * about what the founder meant.
   */
  async function runInstantCommand(command: string, argument: string): Promise<boolean> {
    let sessionId = activeId;
    if (!sessionId) {
      sessionId = await createSession();
      if (!sessionId) return false;
    }
    setDraft("");
    setNotice(null);
    setPending(true);
    try {
      const res = await apiFetch(`${base}/sessions/${sessionId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, argument }),
      });
      if (!res.ok) {
        setNotice("Couldn't run that command.");
        return false;
      }
      const body = (await res.json()) as { userMessage: ChatMessage; message: ChatMessage };
      setMessages((prev) => [...prev, body.userMessage, body.message]);
      void loadSessions();
      return true;
    } catch {
      setNotice("Couldn't reach the assistant. Check your connection and try again.");
      return false;
    } finally {
      setPending(false);
    }
  }

  /**
   * A card's button (D-77.3). It issues the SAME request /review issues, which
   * is why the decision-log record is identical — the same route writes it.
   * The card is then reloaded from the server rather than patched optimistically:
   * an approval can change more than the state we guessed at.
   */
  async function actOnCard(card: ChatCard, action: "approve" | "reject" | "edit", content?: string) {
    const request = cardActionRequest(card, action, workspaceId);
    if (!request || !activeId) return;
    setResolving(card.ref);
    try {
      const res = await apiFetch(request.path, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "edit" ? { content } : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setNotice(body.message ?? "That couldn't go through.");
        return;
      }
      setNotice(
        action === "approve"
          ? "Approved. It's recorded in the decision log exactly as it would be from Review."
          : action === "reject"
            ? "Rejected."
            : "Saved.",
      );
      await loadSession(activeId);
    } catch {
      setNotice("Couldn't reach the assistant. Check your connection and try again.");
    } finally {
      setResolving(null);
    }
  }

  /**
   * Confirm or decline one proposal. The response IS the resolved proposal —
   * including a `failed` one, because a governed refusal is an answer the
   * founder needs to read on the card, not an HTTP error to swallow.
   */
  async function resolveProposalCard(proposal: ChatProposal, decision: "confirm" | "decline") {
    if (!activeId || resolving) return;
    setResolving(proposal.id);
    try {
      const res = await apiFetch(
        `${base}/sessions/${activeId}/proposals/${proposal.id}/${decision}`,
        { method: "POST" },
      );
      if (!res.ok) {
        setNotice(
          res.status === 409
            ? "That was already confirmed or declined."
            : "Couldn't complete that. Try again.",
        );
        await loadSession(activeId);
        return;
      }
      const updated: ChatProposal = await res.json();
      setProposals((prev) => mergeProposal(prev, updated));
      // Confirming appends a receipt (or a refusal) to the transcript.
      if (decision === "confirm") await loadSession(activeId);
      void loadSessions();
    } catch {
      setNotice("Couldn't reach the assistant. Check your connection and try again.");
    } finally {
      setResolving(null);
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;

    // Sprint 77: the same parser the API uses, so the client and the server
    // agree on what is a command. An instant one never becomes a model turn.
    const parsed = parseChatCommand(message);
    if (parsed?.kind === "instant") {
      await runInstantCommand(parsed.command, parsed.argument);
      return;
    }

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
        body: JSON.stringify({
          message,
          // A directive command pins the turn's intent; the INSTRUCTION comes
          // from the API, never from here (D-77.4).
          ...(parsed?.kind === "directive" ? { command: parsed.command } : {}),
        }),
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
        setProposals((prev) => turn.proposals.reduce(mergeProposal, prev));
        void loadSessions();
        return;
      }

      let settled = false;
      let sawProposal = false;
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
          case "card":
            // Records appear while the run is still going, which is most of
            // what "generative UI" means to someone watching a six-step turn.
            setLive((prev) => ({ ...prev, cards: [...prev.cards, ...event.cards] }));
            break;
          case "proposal":
            // Arrives mid-run, before the answer settles: the founder sees what
            // it is about to ask for while it is still writing the sentence.
            sawProposal = true;
            setProposals((prev) => mergeProposal(prev, event.proposal));
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
      // A proposal frame also needs the refetch: it is streamed before the
      // message it belongs to exists, so the client's copy has no messageId.
      if (!settled || sawProposal) await loadSession(sessionId);
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

  /**
   * Move the composer's request to the background (D-79.3). Explicitly a
   * button: the model never decides that a request is long-running, because a
   * founder who did not ask for a background run should never get one.
   */
  async function detach(text: string) {
    const message = text.trim();
    if (!message || pending) return;

    let sessionId = activeId;
    if (!sessionId) {
      sessionId = await createSession();
      if (!sessionId) return;
    }

    setDraft("");
    setNotice(null);
    setPending(true);
    try {
      const res = await apiFetch(`${base}/sessions/${sessionId}/detach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setNotice(
          body.message ?? "Couldn't start that in the background. Try sending it here instead.",
        );
        setDraft(message);
        return;
      }
      const created: AgentTaskCreated = await res.json();
      setMessages((prev) => [
        ...prev,
        ...(created.userMessage ? [created.userMessage] : []),
        ...(created.message ? [created.message] : []),
      ]);
      setTasks((prev) => [created.task, ...prev]);
      setOpenTaskId(created.task.id);
      // The budget warning is shown, not enforced — they pressed the button
      // and the run is allowed; they just deserve to know what it could cost.
      setNotice(budgetWarningText(created.budgetWarning));
      void loadSessions();
    } catch {
      setNotice("Couldn't reach the assistant. Check your connection and try again.");
      setDraft(message);
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const openTask = tasks.find((t) => t.id === openTaskId) ?? null;
  const budget = activeSession ? threadBudgetView(activeSession) : null;
  const shown = filterVisible(messages);

  // The `/` palette and the `@` picker, both driven by what is in the composer
  // right now. Neither is a mode the founder has to enter or leave.
  const slash = commandQuery(draft);
  const commandMatches =
    slash === null ? [] : CHAT_COMMANDS.filter((c) => c.name.startsWith(slash));
  const mention = mentionQuery(draft);
  // Computed plainly rather than memoised: this sits AFTER the `!open` early
  // return, where a hook would be a conditional one, and filtering a few dozen
  // options per keystroke costs nothing.
  const mentionMatches =
    mention === null
      ? []
      : (() => {
          const pinned = new Set(pins.map((p) => `${p.kind}:${p.refId}`));
          return mentionOptions
            .filter((o) => !pinned.has(`${o.kind}:${o.refId}`))
            .filter((o) => (mention ? o.label.toLowerCase().includes(mention) : true))
            .slice(0, 8);
        })();

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

            {pins.length > 0 && (
              <div className={styles.pinBar}>
                {pins.map((pin) => (
                  <span
                    key={pin.id}
                    className={`${styles.pinChip} ${pinIsUntrusted(pin) ? styles.pinChipUntrusted : ""}`}
                    title={
                      pinIsUntrusted(pin)
                        ? `${pinKindLabel(pin.kind)} — from outside your workspace, so the assistant treats it as data, never as instructions.`
                        : pinKindLabel(pin.kind)
                    }
                  >
                    <span className={styles.pinKind}>{pinKindLabel(pin.kind)}</span>
                    <span className={styles.pinLabel}>{pin.label}</span>
                    <button
                      type="button"
                      className={styles.pinRemove}
                      aria-label={`Unpin ${pin.label}`}
                      onClick={() => void unpin(pin.id)}
                    >
                      <Icon name="close" size="compact" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {(notice ?? budget?.warning ?? pinsSummary(pins) ?? pendingSummary(proposals)) && (
              <p className={styles.notice}>
                <Icon name="info" size="compact" />
                {notice ?? budget?.warning ?? pendingSummary(proposals) ?? pinsSummary(pins)}
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
                      sources. It can put work forward — a draft, a post, a send — but nothing happens
                      until you confirm it, and your action policy still decides what comes next.
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
                          {m.role === "assistant" && m.cards.length > 0 && (
                            <div className={styles.cards}>
                              {m.cards.map((c) => (
                                <ResultCard
                                  key={`${m.id}-${c.kind}-${c.ref}`}
                                  card={c}
                                  workspaceId={workspaceId}
                                  busy={resolving === c.ref}
                                  onAct={(action, content) => void actOnCard(c, action, content)}
                                />
                              ))}
                            </div>
                          )}
                          {m.role === "assistant" &&
                            proposalsForMessage(proposals, m).map((p) => (
                              <ProposalCard
                                key={p.id}
                                proposal={p}
                                workspaceId={workspaceId}
                                busy={resolving === p.id}
                                onResolve={(decision) => void resolveProposalCard(p, decision)}
                              />
                            ))}
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
                        {/* Recorded this turn, before the answer settled. */}
                        {unattachedProposals(proposals).map((p) => (
                          <ProposalCard
                            key={p.id}
                            proposal={p}
                            workspaceId={workspaceId}
                            busy={resolving === p.id}
                            onResolve={(decision) => void resolveProposalCard(p, decision)}
                          />
                        ))}
                        {live.cards.length > 0 && (
                          <div className={styles.cards}>
                            {live.cards.map((c) => (
                              <ResultCard
                                key={`live-${c.kind}-${c.ref}`}
                                card={c}
                                workspaceId={workspaceId}
                                busy={false}
                                onAct={() => {}}
                              />
                            ))}
                          </div>
                        )}
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

            {commandMatches.length > 0 && (
              <div className={styles.palette} role="listbox" aria-label="Commands">
                {commandMatches.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={styles.paletteRow}
                    onClick={() => setDraft(c.argumentHint ? `/${c.name} ` : `/${c.name}`)}
                  >
                    <span className={styles.paletteName}>/{c.name}</span>
                    <span className={styles.paletteSummary}>{c.summary}</span>
                    <span className={styles.paletteKind}>
                      {c.kind === "instant" ? "runs directly" : "asks the assistant"}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {mention !== null && mentionMatches.length > 0 && (
              <div className={styles.palette} role="listbox" aria-label="Pin something">
                {mentionMatches.map((o) => (
                  <button
                    key={`${o.kind}-${o.refId}`}
                    type="button"
                    className={styles.paletteRow}
                    onClick={() => {
                      setDraft((prev) => clearMention(prev));
                      void pinEntity(o.kind, o.refId, o.label);
                    }}
                  >
                    <span className={styles.paletteName}>{pinKindLabel(o.kind)}</span>
                    <span className={styles.paletteSummary}>{o.label}</span>
                  </button>
                ))}
              </div>
            )}

            {openTask && (
              <TaskPanel
                key={openTask.id}
                workspaceId={workspaceId}
                task={openTask}
                onChanged={(next) => {
                  setTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
                }}
                onFinished={() => {
                  // The answer is posted back into the thread, so a finished
                  // task's result belongs in the transcript, not in a panel.
                  if (activeId) void loadSession(activeId);
                }}
                onDismiss={() => setOpenTaskId(null)}
              />
            )}

            <form
              className={styles.composer}
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <Textarea
                className={styles.composerField}
                placeholder="What are you trying to do? / for commands, @ to pin something"
                value={draft}
                rows={1}
                disabled={pending || budget?.exhausted}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Loading the pickable entities on the first `@` keeps the
                  // drawer's open cost at one request, not four.
                  if (mentionQuery(e.target.value) !== null && mentionOptions.length === 0) {
                    void loadMentionOptions();
                  }
                }}
                onPaste={(e) => {
                  // A pasted link becomes a pin, fetched through safe-fetch and
                  // marked untrusted (D-77.6) — vouching for a link is not
                  // vouching for what is on the other end of it.
                  const url = pastedUrl(e.clipboardData.getData("text"));
                  if (url && activeId) {
                    e.preventDefault();
                    void pinEntity("url", url);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <IconButton
                label="Run this in the background"
                // Explicit: a bare <button> inside a <form> submits it, which
                // would send the message AND detach it.
                type="button"
                className={styles.iconBtn}
                disabled={pending || !draft.trim() || budget?.exhausted}
                onClick={() => void detach(draft)}
              >
                <Icon name="status-generating" size="compact" />
              </IconButton>
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

/**
 * The live view of one background task (Sprint 79).
 *
 * Progress arrives over SSE, which is polled from the database server-side
 * (D-79.12) — so this reconnects rather than assuming one socket lasts the
 * fifteen minutes a task may run. Every frame is folded through
 * `applyTaskEvent`, which is where the "arrives twice" cases are handled.
 */
function TaskPanel({
  workspaceId,
  task,
  onChanged,
  onFinished,
  onDismiss,
}: {
  workspaceId: string;
  task: AgentTask;
  onChanged: (task: AgentTask) => void;
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const path = `/workspaces/${workspaceId}/agent-tasks/${task.id}`;

  // One effect owns the whole stream lifecycle. `cancelled` guards every
  // setState after an unmount — a fifteen-minute stream long outlives a
  // founder's patience for keeping the drawer open.
  useEffect(() => {
    let cancelled = false;

    async function follow() {
      try {
        const res = await apiFetch(`${path}/stream`, {
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok) return;
        if (!res.headers.get("content-type")?.includes("text/event-stream")) {
          // A proxy stripped the stream. The same URL answers with the detail.
          const snapshot: AgentTaskDetail = await res.json();
          if (!cancelled) setDetail(snapshot);
          return;
        }
        await readSseStream(res, agentTaskStreamEventSchema, (event) => {
          if (cancelled) return;
          setDetail((prev) => applyTaskEvent(prev ?? { ...task, steps: [], subagents: [], messages: [], questions: [], proposals: [] }, event));
        });
      } catch {
        if (!cancelled) setNote("Lost the live view. The task is still running — reopen to reconnect.");
      }
    }

    void follow();
    return () => {
      cancelled = true;
    };
  }, [path, task.id]);

  const current: AgentTask = detail ?? task;
  const controls = taskControls(current);
  const question = detail ? blockingQuestion(detail) : null;
  const rows = detail ? taskActivity(detail.steps) : [];
  const workers = detail ? subagentRows(detail.subagents, detail.steps) : [];

  // Push status changes back up so the thread list and the panel agree.
  const statusRef = useRef(current.status);
  useEffect(() => {
    if (statusRef.current === current.status) return;
    statusRef.current = current.status;
    onChanged(current);
    if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
      onFinished();
    }
  }, [current, onChanged, onFinished]);

  async function post(action: "steer" | "cancel", body?: unknown) {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(`${path}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        setNote(payload.message ?? "That didn't go through.");
        return false;
      }
      if (action === "cancel") {
        const next: AgentTask = await res.json();
        setDetail((prev) => (prev ? { ...prev, ...next } : prev));
        onChanged(next);
      }
      return true;
    } catch {
      setNote("Couldn't reach the assistant.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${styles.taskPanel} ${styles[`taskPanel${capitalize(taskTone(current))}`] ?? ""}`}>
      <header className={styles.taskHead}>
        <Icon
          name={taskTone(current) === "running" ? "status-generating" : "brain"}
          size="compact"
        />
        <span className={styles.taskStatus}>{taskStatusLabel(current)}</span>
        <span className={styles.taskSpacer} />
        {current.agentRunId && (
          <Link className={styles.taskTrace} href={agentRunHref(workspaceId, current.agentRunId)}>
            Trace
          </Link>
        )}
        <IconButton label="Hide this panel" size="compact" className={styles.iconBtn} onClick={onDismiss}>
          <Icon name="close" size="compact" />
        </IconButton>
      </header>

      <p className={styles.taskTitle}>{current.title || current.request}</p>
      <p className={styles.taskDetail}>{taskStatusDetail(current)}</p>
      {note && <p className={styles.taskNote}>{note}</p>}

      {question && (
        <p className={styles.taskNote}>
          It asked: “{question.question}” — answer it in your inbox and it picks up from there.
        </p>
      )}

      {workers.length > 0 && (
        <ul className={styles.taskWorkers}>
          {workers.map((worker) => (
            <li key={worker.id} className={styles.taskWorker}>
              <Icon
                name={worker.running ? "status-generating" : worker.ok ? "approve" : "reject"}
                size="compact"
              />
              <span className={styles.taskWorkerLabel}>{worker.label}</span>
              {worker.summary && <span className={styles.taskWorkerSummary}>{worker.summary}</span>}
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <>
          <button
            type="button"
            className={styles.taskToggle}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide what it did" : `What it did (${rows.length})`}
          </button>
          {expanded && (
            <ul className={styles.taskActivity}>
              {rows.map((row) => (
                <li key={row.id} className={styles.taskActivityRow}>
                  <Icon name={row.ok ? "approve" : "reject"} size="compact" />
                  {row.label}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {controls.canSteer ? (
        <form
          className={styles.taskSteer}
          onSubmit={(e) => {
            e.preventDefault();
            const message = steer.trim();
            if (!message) return;
            void post("steer", { message }).then((ok) => {
              if (ok) setSteer("");
            });
          }}
        >
          <Textarea
            className={styles.composerField}
            placeholder="Redirect it — it picks this up at its next step"
            value={steer}
            rows={1}
            disabled={busy}
            onChange={(e) => setSteer(e.target.value)}
          />
          <Button type="submit" variant="secondary" loading={busy} disabled={!steer.trim()}>
            Steer
          </Button>
        </form>
      ) : (
        controls.steerDisabledReason &&
        !controls.canRetry && <p className={styles.taskNote}>{controls.steerDisabledReason}</p>
      )}

      <div className={styles.taskActions}>
        {controls.canSteer && (
          <span className={styles.taskHint}>
            {steersRemaining(current)} redirect{steersRemaining(current) === 1 ? "" : "s"} left
          </span>
        )}
        {controls.canCancel && (
          <Button variant="tertiary" loading={busy} onClick={() => void post("cancel")}>
            Stop it
          </Button>
        )}
      </div>
    </section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A typed result card (Sprint 77). The record itself, rendered — and, where the
 * platform already has a route for the action, actionable.
 *
 * The Approve button issues the identical request `/review` issues (D-77.3),
 * which is why the decision-log record it writes is identical: the same route
 * writes it. There is no chat-side approval service, and there must never be
 * one.
 */
function ResultCard({
  card,
  workspaceId,
  busy,
  onAct,
}: {
  card: ChatCard;
  workspaceId: string;
  busy: boolean;
  onAct: (action: "approve" | "reject" | "edit", content?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(card.body ?? "");
  const href = cardHref(card, workspaceId);
  const original = card.body ?? "";
  const spans = editing ? diffWords(original, edited) : [];

  return (
    <div className={`${styles.card} ${styles[`card_${card.kind}`] ?? ""}`}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>{cardKindLabel(card.kind)}</span>
        <span className={styles.cardTitle}>{card.title}</span>
        {card.subtitle && <span className={styles.cardSubtitle}>{card.subtitle}</span>}
      </div>

      {card.fields.length > 0 && (
        <dl className={styles.cardFields}>
          {card.fields.map((f) => (
            <div key={f.label} className={styles.cardField}>
              <dt className={styles.cardFieldLabel}>{f.label}</dt>
              <dd className={styles.cardFieldValue}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {card.body && !editing && <p className={styles.cardBody}>{card.body}</p>}

      {editing && (
        <div className={styles.cardEditor}>
          <Textarea
            className={styles.cardEditorField}
            value={edited}
            rows={6}
            onChange={(e) => setEdited(e.target.value)}
          />
          {/* The diff is the point of editing here: the box is small, the draft
              may be long, and "I thought I only fixed the typo" is how a
              paragraph goes missing. */}
          <p className={styles.cardDiffSummary}>{describeDiff(spans)}</p>
          <p className={styles.cardDiff}>
            {spans.map((span, i) => (
              <span
                key={i}
                className={
                  span.op === "insert"
                    ? styles.diffInsert
                    : span.op === "delete"
                      ? styles.diffDelete
                      : undefined
                }
              >
                {span.text}
              </span>
            ))}
          </p>
        </div>
      )}

      <div className={styles.cardActions}>
        {editing ? (
          <>
            <Button
              variant="primary"
              loading={busy}
              disabled={!hasChanges(original, edited)}
              onClick={() => {
                onAct("edit", edited);
                setEditing(false);
              }}
            >
              Save edit
            </Button>
            <Button variant="tertiary" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {cardHasAction(card, "approve") && (
              <Button variant="primary" loading={busy} onClick={() => onAct("approve")}>
                Approve
              </Button>
            )}
            {cardHasAction(card, "edit") && (
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {cardHasAction(card, "reject") && (
              <Button variant="tertiary" disabled={busy} onClick={() => onAct("reject")}>
                Reject
              </Button>
            )}
            {href && (
              <Link className={styles.cardLink} href={href}>
                Open
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The statement of intent (Sprint 78). This is the whole safety story made
 * visible: what it wants to do, what confirming actually causes, and — when the
 * turn read anything from outside the workspace — a warning to read it twice.
 *
 * The buttons are never hidden on a quarantined card. The founder is the
 * authority here, and a UI that suppressed the choice would be teaching them
 * that warnings are obstacles to route around.
 */
function ProposalCard({
  proposal,
  workspaceId,
  busy,
  onResolve,
}: {
  proposal: ChatProposal;
  workspaceId: string;
  busy: boolean;
  onResolve: (decision: "confirm" | "decline") => void;
}) {
  const tone = proposalTone(proposal);
  const warning = quarantineWarning(proposal);
  const outcome = proposalOutcome(proposal);
  const href = producedHref(proposal, workspaceId);

  return (
    <div className={`${styles.proposal} ${styles[`proposal_${tone}`] ?? ""}`}>
      <div className={styles.proposalHead}>
        <Icon name={tone === "quarantined" ? "info" : "status-learning"} size="compact" />
        <span className={styles.proposalTitle}>{proposal.intent.title}</span>
      </div>

      {proposal.intent.detail.length > 0 && (
        <dl className={styles.proposalDetail}>
          {proposal.intent.detail.map((row) => (
            <div key={row.label} className={styles.proposalRow}>
              <dt className={styles.proposalLabel}>{row.label}</dt>
              <dd className={styles.proposalValue}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className={styles.proposalEffect}>{proposal.intent.effect}</p>
      {proposal.intent.rationale && (
        <p className={styles.proposalRationale}>“{proposal.intent.rationale}”</p>
      )}

      {warning && (
        <p className={styles.proposalWarning}>
          <Icon name="info" size="compact" />
          {warning}
        </p>
      )}

      {isActionable(proposal) ? (
        <div className={styles.proposalActions}>
          <Button variant="primary" loading={busy} onClick={() => onResolve("confirm")}>
            Confirm
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onResolve("decline")}>
            Decline
          </Button>
        </div>
      ) : (
        <p className={styles.proposalOutcome}>
          {outcome}
          {href && (
            <Link className={styles.proposalLink} href={href}>
              Open it
            </Link>
          )}
        </p>
      )}
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
    cards: [],
    agentRunId: null,
    agentTaskId: null,
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
