"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CHANNELS,
  type Campaign,
  type Channel,
  type Persona,
  type UpsertCampaignInput,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Icon } from "@/src/components/ui/icon";
import { Input, Textarea } from "@/src/components/ui/input";
import styles from "../campaigns.module.css";

interface CampaignFormProps {
  workspaceId: string;
  campaign?: Campaign;
  personas: Persona[];
  onCancel(): void;
  onSaved(campaign: Campaign): void;
}

interface FormState {
  name: string;
  objective: string;
  kpi: string;
  timeframe: string;
  audience: string;
  pillarsText: string;
  channels: Channel[];
  personaIds: string[];
  overlay: string;
}

function initialForm(campaign?: Campaign): FormState {
  return campaign
    ? {
        name: campaign.name,
        objective: campaign.objective,
        kpi: campaign.kpi,
        timeframe: campaign.timeframe,
        audience: campaign.audience,
        pillarsText: campaign.pillars.join("\n"),
        channels: campaign.channels,
        personaIds: campaign.personaIds,
        overlay: campaign.overlay,
      }
    : {
        name: "",
        objective: "",
        kpi: "",
        timeframe: "",
        audience: "",
        pillarsText: "",
        channels: [],
        personaIds: [],
        overlay: "",
      };
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

export function CampaignForm({
  workspaceId,
  campaign,
  personas,
  onCancel,
  onSaved,
}: CampaignFormProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(() => initialForm(campaign));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Sprint 53 review (C1): once a campaign has an **active plan revision**, the
    row's five strategy columns — objective / KPI / timeframe / audience /
    pillars — no longer reach any prompt. `composeCampaignOverlay` emits the
    free text alone and the resolver reads `campaign_plan_revisions` for
    strategy, so editing them here would save happily and change nothing the
    model ever sees. A field the founder can type into that silently does
    nothing is worse than no field, so in that state they are read-only and
    point at the plan, which is where strategy is actually edited.

    Before a plan exists they are still live: they seed the backfilled plan and
    feed the legacy structured fallback (`composeLegacyCampaignStrategy`).
  */
  const planManaged = Boolean(campaign?.currentPlanRevisionId);
  const planHref = campaign
    ? `/workspaces/${workspaceId}/campaigns/${campaign.id}?tab=plan`
    : "";
  const planManagedNote = planManaged ? (
    <p className={styles.planManagedNote}>
      Strategy is managed by this campaign&rsquo;s plan — objective, KPI, timeframe, audience and
      pillars below are read-only here and are shown for reference.{" "}
      <Link href={planHref}>Edit the campaign plan</Link> to change what the writer sees.
    </p>
  ) : null;
  const managedLabel = (label: string) => (planManaged ? `${label} (from the campaign plan)` : label);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload: UpsertCampaignInput = {
      name: form.name,
      purpose: campaign?.purpose ?? "initiative",
      objective: form.objective,
      kpi: form.kpi,
      timeframe: form.timeframe,
      audience: form.audience,
      pillars: form.pillarsText
        .split("\n")
        .map((pillar) => pillar.trim())
        .filter(Boolean)
        .slice(0, 10),
      channels: form.channels,
      personaIds: form.personaIds,
      overlay: form.overlay,
      status: campaign?.status ?? "active",
      automationMode: campaign?.automationMode ?? "manual",
      autoDailyCap: campaign?.autoDailyCap ?? null,
    };

    try {
      const response = await apiFetch(
        campaign
          ? `/workspaces/${workspaceId}/campaigns/${campaign.id}`
          : `/workspaces/${workspaceId}/campaigns`,
        {
          method: campaign ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message ?? `API returned ${response.status}`);
      onSaved(body as Campaign);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save campaign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={styles.formCard}>
      <CardHeader
        title={
          <span className={styles.formTitle}>
            <Icon name="campaigns" size="compact" />
            {campaign ? "Edit campaign" : "New campaign"}
            <span>Step {step} of 3</span>
          </span>
        }
      />
      <form className={styles.campaignForm} onSubmit={submit}>
        {step === 1 && (
          <div className={styles.formStack}>
            <label>
              <span>Name</span>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Q3 GTM memory push"
                maxLength={200}
                autoFocus
              />
            </label>
            {planManagedNote}
            <label>
              <span>{managedLabel("Objective")}</span>
              <Textarea
                value={form.objective}
                onChange={(event) => setForm({ ...form, objective: event.target.value })}
                placeholder="What is this campaign trying to achieve?"
                rows={3}
                readOnly={planManaged}
                aria-readonly={planManaged}
              />
            </label>
            <div className={styles.formColumns}>
              <label>
                <span>{managedLabel("KPI")}</span>
                <Input
                  value={form.kpi}
                  onChange={(event) => setForm({ ...form, kpi: event.target.value })}
                  placeholder="20 demo calls booked"
                  readOnly={planManaged}
                  aria-readonly={planManaged}
                />
              </label>
              <label>
                <span>{managedLabel("Timeframe")}</span>
                <Input
                  value={form.timeframe}
                  onChange={(event) => setForm({ ...form, timeframe: event.target.value })}
                  placeholder="Jul–Sep 2026"
                  readOnly={planManaged}
                  aria-readonly={planManaged}
                />
              </label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className={styles.formStack}>
            {planManagedNote}
            <label>
              <span>{managedLabel("Audience")}</span>
              <Textarea
                value={form.audience}
                onChange={(event) => setForm({ ...form, audience: event.target.value })}
                placeholder="Who exactly is this for?"
                rows={3}
                readOnly={planManaged}
                aria-readonly={planManaged}
              />
            </label>
            <label>
              <span>{managedLabel("Messaging pillars")}</span>
              <Textarea
                value={form.pillarsText}
                onChange={(event) => setForm({ ...form, pillarsText: event.target.value })}
                placeholder="One pillar per line, up to 10"
                rows={5}
                readOnly={planManaged}
                aria-readonly={planManaged}
              />
            </label>
          </div>
        )}

        {step === 3 && (
          <div className={styles.formStack}>
            <fieldset className={styles.choiceGroup}>
              <legend>Channels</legend>
              {CHANNELS.map((channel) => (
                <label key={channel}>
                  <input
                    type="checkbox"
                    checked={form.channels.includes(channel)}
                    onChange={() => setForm({ ...form, channels: toggle(form.channels, channel) })}
                  />
                  <span>{channel}</span>
                </label>
              ))}
            </fieldset>
            {personas.length > 0 && (
              <fieldset className={styles.choiceGroup}>
                <legend>Personas</legend>
                {personas.map((persona) => (
                  <label key={persona.id}>
                    <input
                      type="checkbox"
                      checked={form.personaIds.includes(persona.id)}
                      onChange={() =>
                        setForm({ ...form, personaIds: toggle(form.personaIds, persona.id) })
                      }
                    />
                    <span>{persona.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <label>
              {/*
                Sprint 53: this field is *additional instruction*, not strategy.
                Objective / KPI / timeframe / audience / pillars now reach the
                prompt through the campaign plan, so the copy has to stop
                inviting founders to restate strategy here.
              */}
              <span>Additional instruction</span>
              <Textarea
                value={form.overlay}
                onChange={(event) => setForm({ ...form, overlay: event.target.value })}
                placeholder="Anything extra the writer should follow for this campaign — objective, KPI and pillars live in the campaign plan."
                rows={5}
              />
            </label>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <div className={styles.formActions}>
          {step > 1 && (
            <Button type="button" size="compact" onClick={() => setStep(step - 1)}>Back</Button>
          )}
          {step < 3 ? (
            <Button
              variant="primary"
              type="button"
              onClick={() => setStep(step + 1)}
              disabled={!form.name.trim()}
            >
              Next
            </Button>
          ) : (
            <Button variant="primary" type="submit" disabled={saving || !form.name.trim()}>
              {saving ? "Saving…" : campaign ? "Update campaign" : "Create campaign"}
            </Button>
          )}
          <Button type="button" variant="tertiary" size="compact" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
