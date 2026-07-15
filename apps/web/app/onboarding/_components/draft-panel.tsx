"use client";

/**
 * Onboarding Step 7 — the first draft (Sprint 36.6, the finale).
 *
 * On entry, chains three existing endpoints: read the Step-6 campaign's
 * channels (skippable), POST /generate with autoAngle, POST /submit into the
 * approval gate — then lands the user on the Review page with exactly one
 * pending_review draft waiting. Every failure leaves a path forward:
 * 402 → billing link + "Finish without a draft"; anything else → Retry
 * (resuming mid-chain, so a submit failure never re-spends a generation).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CHANNEL_LABELS,
  taskTypeForChannel,
  type Channel,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import type { WizardPanelProps } from "./types";
import "./draft-panel.css";

type Phase = "working" | "limit" | "error" | "ready";

const EXCERPT_WORDS = 60;

/** First ~60 words of the generation output for the preview card. */
function excerptOf(output: string): string {
  const words = output.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const head = words.slice(0, EXCERPT_WORDS).join(" ");
  return words.length > EXCERPT_WORDS ? `${head}…` : head;
}

function stageMessages(channel: Channel): string[] {
  return [
    "Reading your Brain and campaign…",
    "Picking the strongest angle…",
    `Writing your first ${CHANNEL_LABELS[channel]} draft…`,
  ];
}

export function DraftPanel({
  workspaceId,
  userName,
  campaignId,
  onContinue,
  onError,
}: WizardPanelProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("working");
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [output, setOutput] = useState("");
  const [stage, setStage] = useState(0);
  const [busy, setBusy] = useState(false);

  // The chain's checkpoint: once a generation exists, Retry resumes at submit
  // instead of spending a second generation.
  const generationRef = useRef<{ id: string; output: string } | null>(null);

  const run = useCallback(async () => {
    setPhase("working");
    setStage(0);
    onError(null);
    try {
      let generation = generationRef.current;

      if (!generation) {
        // 1. Read the campaign's channels (campaign step is skippable — no
        //    campaignId, or a failed read, just means we draft for LinkedIn).
        let picked: Channel = "linkedin";
        if (campaignId) {
          try {
            const res = await apiFetch(
              `/workspaces/${workspaceId}/campaigns/${campaignId}`,
            );
            if (res.ok) {
              const campaign = await res.json();
              picked = (campaign?.channels?.[0] as Channel | undefined) ?? "linkedin";
            }
          } catch {
            // best-effort — fall through to linkedin
          }
        }
        setChannel(picked);

        // 2. Generate — the server picks the strongest angle and drafts.
        const genRes = await apiFetch(`/workspaces/${workspaceId}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskType: taskTypeForChannel(picked),
            channel: picked,
            campaignId: campaignId ?? undefined,
            autoAngle: true,
          }),
        });
        const genBody = await genRes.json().catch(() => null);
        if (genRes.status === 402) {
          setPhase("limit");
          return;
        }
        if (!genRes.ok) {
          throw new Error(genBody?.message ?? "The draft didn't come through");
        }
        generation = { id: genBody.id as string, output: genBody.output as string };
        generationRef.current = generation;
      }

      // 3. Submit to the approval gate. A 409 already_submitted (double-fire)
      //    means the draft is already waiting — that's success.
      const subRes = await apiFetch(
        `/workspaces/${workspaceId}/generations/${generation.id}/submit`,
        { method: "POST" },
      );
      if (!subRes.ok && subRes.status !== 409) {
        const subBody = await subRes.json().catch(() => null);
        throw new Error(subBody?.message ?? "Could not send the draft to review");
      }

      setOutput(generation.output);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      onError(err instanceof Error ? err.message : "The draft didn't come through");
    }
  }, [workspaceId, campaignId, onError]);

  // Fire the finale exactly once on mount — the ref guards against React
  // strict mode's double-invoked effects (a second in-flight POST would
  // double the LLM spend and race the submit).
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void run();
  }, [run]);

  // Staged status line while the generation is in flight.
  const stages = stageMessages(channel);
  useEffect(() => {
    if (phase !== "working") return;
    const timer = setInterval(
      () => setStage((s) => Math.min(s + 1, stages.length - 1)),
      2600,
    );
    return () => clearInterval(timer);
  }, [phase, stages.length]);

  /** Primary CTA — land on the Review page, the onboarding "aha".
   * onContinue's advance() would redirect to /workspaces/:id, racing our
   * push — so we PATCH the cursor to "done" ourselves and route directly. */
  async function reviewNow() {
    setBusy(true);
    onError(null);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "done" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Could not finish onboarding");
      }
      router.push(`/workspaces/${workspaceId}/review`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not finish onboarding");
      setBusy(false);
    }
  }

  /** Secondary path — let the shell advance to "done" and redirect home. */
  async function finishViaShell() {
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  if (phase === "working") {
    return (
      <Card className="ob-panel">
        <h1>One draft, coming up</h1>
        <p className="subtitle ob-draft-pulse" aria-live="polite">
          {stages[stage]}
        </p>
        <p className="ob-draft-hint">
          Everything it writes goes through your review — nothing publishes itself.
        </p>
      </Card>
    );
  }

  if (phase === "limit") {
    return (
      <Card className="ob-panel">
        <h1>You&apos;ve hit the generation limit</h1>
        <p className="subtitle">
          Your plan&apos;s monthly generations are used up, so we couldn&apos;t write this first
          draft. Upgrade to keep drafting — or finish setup now and draft later.
        </p>
        <div className="ob-actions">
          <ButtonLink variant="secondary" size="standard" href={`/workspaces/${workspaceId}/billing`}>
            See plans &amp; billing →
          </ButtonLink>
          <Button variant="tertiary" size="compact" disabled={busy} onClick={finishViaShell}>
            {busy ? "Finishing…" : "Finish without a draft"}
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "error") {
    return (
      <Card className="ob-panel">
        <h1>The draft didn&apos;t come through</h1>
        <p className="subtitle">
          Something went wrong on the way — the details are in the message above. Retry now, or
          finish setup and draft your first post from the workspace instead.
        </p>
        <div className="ob-actions">
          <Button variant="tertiary" size="compact" disabled={busy} onClick={finishViaShell}>
            Finish without a draft
          </Button>
          <Button variant="tertiary" size="compact" disabled={busy} onClick={() => void run()}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  // phase === "ready" — celebratory, but restrained.
  return (
    <Card className="ob-panel">
      <h1>
        Your first draft is waiting for review
        {userName ? `, ${userName}` : ""}
      </h1>
      <p className="subtitle">
        Written from your Brain, in your voice, for your campaign — and parked at the approval
        gate until you say so.
      </p>

      <Card className="ob-draft-card">
        <div className="ob-draft-card-head">
          <span className="layer-badge ob-draft-channel">{CHANNEL_LABELS[channel]} draft</span>
          <span className="ob-draft-status">pending review</span>
        </div>
        <p className="ob-draft-excerpt">{excerptOf(output) || "Your draft is ready to read."}</p>
      </Card>

      <div className="ob-actions">
        <Button variant="primary" disabled={busy} onClick={reviewNow}>
          {busy ? "Opening…" : "Review it now →"}
        </Button>
      </div>
    </Card>
  );
}
