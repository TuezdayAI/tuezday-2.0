"use client";

import { useCallback, useEffect, useState } from "react";
import {
  VOICE_DIMENSIONS,
  type BrandProfile,
  type UpdateBrandProfileInput,
  type VoiceDimension,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Input, Textarea } from "@/src/components/ui/input";
import type { WizardPanelProps } from "./types";
import "./verify-panel.css";

const DIMENSION_LABELS: Record<VoiceDimension, string> = {
  purpose: "Purpose",
  audience: "Audience",
  tone: "Tone",
  emotions: "Emotions",
  character: "Character",
  syntax: "Syntax",
  language: "Language",
};

const POLL_MS = 2500;

type Phase = "loading" | "reading" | "ready" | "failed";

interface FormState {
  businessName: string;
  tagline: string;
  summary: string;
  targetAgeRange: string;
  tone: string;
  voiceDimensions: Record<VoiceDimension, string>;
  pillarsText: string;
  sourceNotes: string;
}

function seedForm(profile: BrandProfile): FormState {
  const dims = {} as Record<VoiceDimension, string>;
  for (const dim of VOICE_DIMENSIONS) dims[dim] = profile.voiceDimensions?.[dim] ?? "";
  return {
    businessName: profile.businessName ?? "",
    tagline: profile.tagline ?? "",
    summary: profile.summary ?? "",
    targetAgeRange: profile.targetAgeRange ?? "",
    tone: profile.tone ?? "",
    voiceDimensions: dims,
    pillarsText: (profile.pillars ?? []).join(", "),
    sourceNotes: profile.sourceNotes ?? "",
  };
}

/** "a, b,, c" → ["a", "b", "c"] — trimmed, capped at the schema's max of 8. */
function parsePillars(text: string): string[] {
  return text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.slice(0, 200))
    .slice(0, 8);
}

/**
 * Onboarding Step 4 (Sprint 36.5): the editable verification form over the
 * brand profile Tuezday extracted from the website + socials. Save PATCHes the
 * profile, then advances the cursor; "Skip for now" advances without saving.
 */
export function VerifyPanel({ workspaceId, userName, onContinue, onError }: WizardPanelProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [form, setForm] = useState<FormState | null>(null);
  const [storedError, setStoredError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/brand-profile`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setStoredError(body?.message ?? null);
        setPhase("failed");
        return;
      }
      const status: string = body?.status ?? "none";
      if (status === "ready" && body.profile) {
        // Seed once — polling must never clobber in-progress edits.
        setForm((prev) => prev ?? seedForm(body.profile as BrandProfile));
        setPhase("ready");
      } else if (status === "scraping" || status === "extracting") {
        setPhase("reading");
      } else {
        setStoredError(typeof body?.error === "string" ? body.error : null);
        setPhase("failed");
      }
    } catch {
      setStoredError(null);
      setPhase("failed");
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the scraper/extractor is still working, re-check every 2.5s.
  useEffect(() => {
    if (phase !== "reading") return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [phase, load]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function setDimension(dim: VoiceDimension, value: string) {
    setForm((f) =>
      f ? { ...f, voiceDimensions: { ...f.voiceDimensions, [dim]: value } } : f,
    );
  }

  async function retry() {
    setBusy(true);
    onError(null);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/brand-profile/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        onError(body?.message ?? "Could not restart the read");
        return;
      }
      setStoredError(null);
      setPhase("loading");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveAndContinue() {
    if (!form) return;
    setBusy(true);
    onError(null);
    try {
      const payload: UpdateBrandProfileInput = {
        businessName: form.businessName.trim(),
        tagline: form.tagline,
        summary: form.summary,
        targetAgeRange: form.targetAgeRange,
        tone: form.tone,
        voiceDimensions: form.voiceDimensions,
        pillars: parsePillars(form.pillarsText),
      };
      const res = await apiFetch(`/workspaces/${workspaceId}/brand-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        onError(body?.message ?? "Could not save your edits");
        return;
      }
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    onError(null);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  const heading = userName ? `Did we get this right, ${userName}?` : "Did we get this right?";

  if (phase === "loading") {
    return (
      <Card className="ob-panel">
        <h1>{heading}</h1>
        <p className="subtitle">Fetching what we learned about your brand…</p>
      </Card>
    );
  }

  if (phase === "reading") {
    return (
      <Card className="ob-panel">
        <h1>{heading}</h1>
        <div className="vp-reading" role="status">
          <span className="vp-reading-dot" aria-hidden="true" />
          <span>Still reading…</span>
        </div>
        <p className="subtitle">
          Tuezday is still reading your website and socials. This usually takes under a
          minute — this screen will update on its own.
        </p>
      </Card>
    );
  }

  if (phase === "failed" || !form) {
    return (
      <Card className="ob-panel">
        <h1>{heading}</h1>
        <p className="subtitle">
          We couldn&apos;t read your website, so there&apos;s nothing to verify yet.
        </p>
        {storedError && <p className="vp-stored-error">{storedError}</p>}
        <div className="ob-actions">
          <Button type="button" variant="tertiary" size="compact" disabled={busy} onClick={retry}>
            {busy ? "Retrying…" : "Retry"}
          </Button>
          <Button type="button" variant="tertiary" size="compact" disabled={busy} onClick={skip}>
            Continue anyway
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="ob-panel">
      <h1>{heading}</h1>
      <p className="subtitle">
        This is what we learned about your brand. Fix anything that&apos;s off — it seeds
        your Brain.
      </p>

      <div className="vp-form">
        <label className="vp-field">
          <span>Business name</span>
          <Input
            value={form.businessName}
            maxLength={200}
            onChange={(e) => setField("businessName", e.target.value)}
          />
        </label>

        <label className="vp-field">
          <span>Tagline</span>
          <Input
            value={form.tagline}
            maxLength={300}
            onChange={(e) => setField("tagline", e.target.value)}
          />
        </label>

        <label className="vp-field">
          <span>Summary</span>
          <Textarea
            className="vp-textarea"
            value={form.summary}
            maxLength={2000}
            rows={4}
            onChange={(e) => setField("summary", e.target.value)}
          />
        </label>

        <div className="vp-row">
          <label className="vp-field">
            <span>Target age range</span>
            <Input
              value={form.targetAgeRange}
              maxLength={100}
              placeholder="e.g. 25-45"
              onChange={(e) => setField("targetAgeRange", e.target.value)}
            />
            <span className="vp-hint">e.g. 25-45</span>
          </label>
          <label className="vp-field">
            <span>Tone</span>
            <Input
              value={form.tone}
              maxLength={500}
              onChange={(e) => setField("tone", e.target.value)}
            />
          </label>
        </div>

        <fieldset className="vp-dimensions">
          <legend>Voice dimensions</legend>
          <div className="vp-grid">
            {VOICE_DIMENSIONS.map((dim) => (
              <label key={dim} className="vp-field">
                <span>{DIMENSION_LABELS[dim]}</span>
                <Input
                  value={form.voiceDimensions[dim]}
                  maxLength={500}
                  onChange={(e) => setDimension(dim, e.target.value)}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <label className="vp-field">
          <span>Content pillars</span>
          <Input
            value={form.pillarsText}
            onChange={(e) => setField("pillarsText", e.target.value)}
            placeholder="Product education, Founder stories, Industry news"
          />
          <span className="vp-hint">Comma-separated, up to 8.</span>
        </label>

        {form.sourceNotes.trim() && (
          <div className="vp-notes">
            <h2>What we couldn&apos;t find</h2>
            <p>{form.sourceNotes}</p>
          </div>
        )}
      </div>

      <div className="ob-actions">
        <span />
        <Button
          type="button"
          variant="primary"
          disabled={busy || form.businessName.trim().length === 0}
          onClick={saveAndContinue}
        >
          {busy ? "Saving…" : "Save & continue"}
        </Button>
      </div>
    </Card>
  );
}
