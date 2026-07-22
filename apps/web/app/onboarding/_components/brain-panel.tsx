"use client";

/**
 * Onboarding Step 5 — "Meet your Brain" (Sprint 36.5).
 *
 * On entry, fires POST /workspaces/:id/brain/auto-draft (36.4 — idempotent,
 * fills empty docs only), shows a drafting state, then reveals the five brain
 * docs in BRAIN_DOC_META order with the honest completeness score and per-doc
 * badges. `insufficient: true` gets truthful guidance instead of fake cards.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainDocType, BrainDocument } from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainScore, type DocStatus } from "@tuezday/brain";
import { apiFetch } from "@/lib/api";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import type { WizardPanelProps } from "./types";
import "./brain-panel.css";

interface AutoDraftView {
  insufficient: boolean;
  drafted: BrainDocType[];
  skipped: BrainDocType[];
  brain: {
    docs: BrainDocument[];
    completeness: BrainScore;
  };
}

type Phase = "drafting" | "ready" | "insufficient" | "error";

const EXCERPT_WORDS = 40;

/** First ~40 words of a doc, with markdown scaffolding stripped for prose. */
function excerptOf(content: string): string {
  const prose = content
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[-*>]\s+/gm, "") // bullets / blockquotes
    .replace(/[*_`]/g, "")
    .trim();
  const words = prose.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const head = words.slice(0, EXCERPT_WORDS).join(" ");
  return words.length > EXCERPT_WORDS ? `${head}…` : head;
}

const STATUS_LABEL: Record<DocStatus, string> = {
  empty: "empty",
  draft: "draft",
  complete: "complete",
};

export function BrainPanel({ workspaceId, userName, onContinue, onError }: WizardPanelProps) {
  const [phase, setPhase] = useState<Phase>("drafting");
  const [view, setView] = useState<AutoDraftView | null>(null);
  const [busy, setBusy] = useState(false);

  const draft = useCallback(async () => {
    setPhase("drafting");
    onError(null);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/brain/auto-draft`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? "Could not draft your Brain");
      }
      const next = body as AutoDraftView;
      setView(next);
      setPhase(next.insufficient ? "insufficient" : "ready");
    } catch (err) {
      setPhase("error");
      onError(err instanceof Error ? err.message : "Could not draft your Brain");
    }
  }, [workspaceId, onError]);

  // Fire the auto-draft exactly once on mount — the ref guards against React
  // strict mode's double-invoked effects (the endpoint is idempotent, but a
  // second in-flight POST would double the LLM spend for nothing).
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void draft();
  }, [draft]);

  async function handleContinue() {
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  if (phase === "drafting") {
    return (
      <Card className="ob-panel">
        <h1>Drafting your Brain…</h1>
        <p className="subtitle ob-drafting-pulse">
          Reading your brand profile and socials, then writing the first pass of your five brain
          docs. Nothing here is final — every word stays editable.
        </p>
      </Card>
    );
  }

  if (phase === "error") {
    return (
      <Card className="ob-panel">
        <h1>Your Brain isn&apos;t drafted yet</h1>
        <p className="subtitle">
          The drafting call failed — the details are in the message above. You can retry now, or
          continue and draft later from the Brain editor.
        </p>
        <div className="ob-actions">
          <Button type="button" variant="tertiary" size="compact" onClick={() => void draft()}>
            Retry
          </Button>
          <Button variant="primary" disabled={busy} onClick={handleContinue}>
            {busy ? "Continuing…" : "Continue"}
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "insufficient") {
    return (
      <Card className="ob-panel">
        <h1>We don&apos;t have enough to draft from yet</h1>
        <p className="subtitle">
          Your Brain drafts from your verified brand profile and connected socials — and right now
          both are empty. Rather than invent a generic brand, we left the five docs blank.
        </p>
        <ul className="ob-brain-guidance">
          <li>Check the website URL on your workspace — a readable site gives us the most.</li>
          <li>Connect a social account so we can learn from what you already publish.</li>
          <li>Or write the docs yourself in the Brain editor — it&apos;s built for that.</li>
        </ul>
        <ButtonLink variant="tertiary" size="compact" href={`/workspaces/${workspaceId}`}>
          Back to your workspace
        </ButtonLink>
        <div className="ob-actions">
          <ButtonLink variant="tertiary" size="compact" href={`/workspaces/${workspaceId}/brain`}>
            Open the full Brain editor →
          </ButtonLink>
          <Button variant="primary" disabled={busy} onClick={handleContinue}>
            {busy ? "Continuing…" : "Continue"}
          </Button>
        </div>
      </Card>
    );
  }

  // phase === "ready"
  const brain = view!.brain;
  const skipped = new Set(view!.skipped);

  return (
    <Card className="ob-panel">
      <h1>
        Meet your Brain
        {userName ? `, ${userName}` : ""}
      </h1>
      <p className="subtitle">
        Five living documents that steer everything Tuezday writes for you. We drafted the first
        pass — <strong>{brain.completeness.percent}% complete</strong> so far, and thin docs are
        marked honestly.
      </p>

      <ol className="ob-brain-grid">
        {BRAIN_DOC_META.map((meta, i) => {
          const doc = brain.docs.find((d) => d.docType === meta.docType);
          const score = brain.completeness.docs.find((d) => d.docType === meta.docType);
          const status: DocStatus = score?.status ?? "empty";
          const wasSkipped = skipped.has(meta.docType);
          const excerpt = doc ? excerptOf(doc.content) : "";
          return (
            <li key={meta.docType}>
              <Card className="ob-brain-card" style={{ animationDelay: `${i * 90}ms` }}>
                <div className="ob-brain-card-head">
                  <h2>{meta.title}</h2>
                  <span
                    className={`layer-badge ${wasSkipped ? "ob-doc-skipped" : `ob-doc-${status}`}`}
                  >
                    {wasSkipped ? "already yours" : STATUS_LABEL[status]}
                  </span>
                </div>
                {excerpt ? (
                  <p className="ob-brain-excerpt">{excerpt}</p>
                ) : (
                  <p className="ob-brain-excerpt ob-brain-excerpt-empty">
                    Nothing drafted yet — {meta.description}
                  </p>
                )}
                <ButtonLink
                  variant="tertiary"
                  size="compact"
                  className="ob-brain-edit"
                  href={`/workspaces/${workspaceId}/brain`}
                >
                  Edit
                </ButtonLink>
              </Card>
            </li>
          );
        })}
      </ol>

      <div className="ob-actions">
        <ButtonLink variant="tertiary" size="compact" href={`/workspaces/${workspaceId}/brain`}>
          Open the full Brain editor →
        </ButtonLink>
        <Button variant="primary" disabled={busy} onClick={handleContinue}>
          {busy ? "Continuing…" : "Continue"}
        </Button>
      </div>
    </Card>
  );
}
