"use client";

import { useState } from "react";
import {
  CHANNELS,
  GENERATION_TASK_TYPES,
  type Audience,
  type CampaignPlanRevision,
  type Channel,
  type CreateCampaignPlanRevisionInput,
  type TaskType,
} from "@tuezday/contracts";
import type { ResolvedContext } from "@tuezday/brain";
import { ContextSectionsTrace } from "@/components/why-this-output";
import { Button } from "@/src/components/ui/button";
import { Input, Select, Textarea } from "@/src/components/ui/input";
import { apiFetch } from "@/lib/api";
import { dateOnlyToTimestamp, timestampToDateOnly } from "@/lib/campaign-control-plane";
import styles from "../campaign-workspace.module.css";

interface CampaignPlanFormProps {
  workspaceId: string;
  campaignId: string;
  initial: CampaignPlanRevision | null;
  audiences: Audience[];
  busy: boolean;
  onCancel(): void;
  onSubmit(input: CreateCampaignPlanRevisionInput): Promise<void>;
}

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
  meta_ad_creative: "Meta ad creative",
  google_rsa: "Google RSA",
  pr_pitch: "Media pitch",
  press_boilerplate: "Press boilerplate",
  x_dm: "X DM",
  instagram_post: "Instagram post",
  engagement_reply: "Reply",
  instagram_carousel: "Instagram carousel",
  // Labelled but never offered: the pickers iterate
  // GENERATION_TASK_TYPES (Sprint 76, D-76.6).
  gtm_conversation: "GTM conversation",
};

function lines(value: string): string[] {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

/**
 * `/resolve` only composes context for a campaign that can execute, so a paused
 * or archived campaign answers with a bare error code. Say what that means.
 */
function previewFailure(body: { error?: string; message?: string } | null): string {
  if (body?.error === "campaign_inactive") {
    return "This campaign is not active, so there is no context to resolve. Reactivate it to preview.";
  }
  if (body?.error === "campaign_archived") {
    return "This campaign is archived, so there is no context to resolve.";
  }
  return body?.message ?? "Could not resolve this draft.";
}

export function CampaignPlanForm({
  workspaceId,
  campaignId,
  initial,
  audiences,
  busy,
  onCancel,
  onSubmit,
}: CampaignPlanFormProps) {
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [kpi, setKpi] = useState(initial?.kpi ?? "");
  const [timeframe, setTimeframe] = useState(initial?.timeframe ?? "");
  const [startAt, setStartAt] = useState(timestampToDateOnly(initial?.startAt ?? null));
  const [endAt, setEndAt] = useState(timestampToDateOnly(initial?.endAt ?? null));
  const [audienceIds, setAudienceIds] = useState<string[]>(initial?.audienceIds ?? []);
  const [pillars, setPillars] = useState((initial?.pillars ?? []).join("\n"));
  const [offers, setOffers] = useState((initial?.offers ?? []).join("\n"));
  const [ctas, setCtas] = useState((initial?.ctas ?? []).join("\n"));
  const [guidance, setGuidance] = useState(initial?.guidance ?? "");
  const [error, setError] = useState<string | null>(null);

  // Sprint 53: the context preview. The plan only reaches the model through the
  // resolver, so the honest preview is a real resolve — of the values in this
  // form, which are not saved anywhere yet.
  const [previewTaskType, setPreviewTaskType] = useState<TaskType>("linkedin_post");
  const [previewChannel, setPreviewChannel] = useState<Channel>("linkedin");
  const [bundle, setBundle] = useState<ResolvedContext | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function toggleAudience(id: string) {
    setAudienceIds((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  /** The revision this form currently describes — submitted, and previewed. */
  function planDraft(): CreateCampaignPlanRevisionInput {
    return {
      objective,
      kpi,
      timeframe,
      startAt: dateOnlyToTimestamp(startAt),
      endAt: dateOnlyToTimestamp(endAt),
      audienceIds,
      pillars: lines(pillars).slice(0, 20),
      offers: lines(offers).slice(0, 20),
      ctas: lines(ctas).slice(0, 20),
      guidance,
    };
  }

  async function preview() {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: previewTaskType,
          channel: previewChannel,
          campaignId,
          campaignPlanDraft: planDraft(),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(previewFailure(body));
      setBundle(body as ResolvedContext);
    } catch (cause) {
      setBundle(null);
      setPreviewError(cause instanceof Error ? cause.message : "Could not resolve this draft.");
    } finally {
      setPreviewing(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = planDraft();
    if (input.startAt !== null && input.endAt !== null && input.endAt <= input.startAt) {
      setError("Campaign end must be after its start.");
      return;
    }
    setError(null);
    try {
      await onSubmit(input);
    } catch {
      // The parent owns the API error so the editor can remain open with its values preserved.
    }
  }

  return (
    <form className={styles.planForm} onSubmit={submit}>
      <div className={styles.formColumns}>
        <label>
          <span>Objective</span>
          <Textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} />
        </label>
        <label>
          <span>Campaign guidance</span>
          <Textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} rows={4} />
        </label>
      </div>
      <div className={styles.formColumnsThree}>
        <label><span>KPI</span><Input value={kpi} onChange={(event) => setKpi(event.target.value)} /></label>
        <label><span>Timeframe label</span><Input value={timeframe} onChange={(event) => setTimeframe(event.target.value)} /></label>
        <label><span>Start date</span><Input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label>
        <label><span>End date</span><Input type="date" value={endAt} onChange={(event) => setEndAt(event.target.value)} /></label>
      </div>
      <fieldset className={styles.audienceChoices}>
        <legend>Audiences</legend>
        {audiences.length === 0 ? (
          <p>No audiences are available in this workspace.</p>
        ) : audiences.map((audience) => (
          <label key={audience.id}>
            <input
              type="checkbox"
              checked={audienceIds.includes(audience.id)}
              onChange={() => toggleAudience(audience.id)}
            />
            <span>{audience.name}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.formColumnsThree}>
        <label><span>Pillars · one per line</span><Textarea value={pillars} onChange={(event) => setPillars(event.target.value)} rows={5} /></label>
        <label><span>Offers · one per line</span><Textarea value={offers} onChange={(event) => setOffers(event.target.value)} rows={5} /></label>
        <label><span>Calls to action · one per line</span><Textarea value={ctas} onChange={(event) => setCtas(event.target.value)} rows={5} /></label>
      </div>

      <section className={styles.planPreview}>
        <div className={styles.previewHeading}>
          <div>
            <p className={styles.panelKicker}>Context preview</p>
            <h4>What the LLM will see</h4>
          </div>
          <span>Resolves these unsaved values, not the active revision. Nothing is saved.</span>
        </div>
        <div className={styles.previewControls}>
          <label>
            <span>Task</span>
            <Select
              value={previewTaskType}
              onChange={(event) => setPreviewTaskType(event.target.value as TaskType)}
            >
              {GENERATION_TASK_TYPES.map((task) => (
                <option key={task} value={task}>{TASK_LABELS[task]}</option>
              ))}
            </Select>
          </label>
          <label>
            <span>Channel</span>
            <Select
              value={previewChannel}
              onChange={(event) => setPreviewChannel(event.target.value as Channel)}
            >
              {CHANNELS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </Select>
          </label>
          <Button variant="secondary" type="button" disabled={previewing} onClick={() => void preview()}>
            {previewing ? "Resolving…" : "Preview context"}
          </Button>
        </div>
        {previewError && <p className="error" role="alert">{previewError}</p>}
        {bundle && (
          <div className="bundle">
            <p className="bundle-summary">
              {bundle.sections.filter((section) => section.included).length} of{" "}
              {bundle.sections.length} sections included · ~{bundle.includedTokens} tokens of{" "}
              {bundle.tokenBudget} budget
              {bundle.overBudget && (
                <span className="error"> — over budget: trim the plan or the brain docs</span>
              )}
            </p>
            <ContextSectionsTrace sections={bundle.sections} />
            <details className={styles.previewPrompt}>
              <summary>Full prompt</summary>
              <pre className="section-content">{bundle.prompt}</pre>
            </details>
          </div>
        )}
      </section>

      {error && <p className="error" role="alert">{error}</p>}
      <div className={styles.formActions}>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create draft revision"}</Button>
        <Button variant="tertiary" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
