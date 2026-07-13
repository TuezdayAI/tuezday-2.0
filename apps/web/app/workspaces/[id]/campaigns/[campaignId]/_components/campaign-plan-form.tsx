"use client";

import { useState } from "react";
import type {
  Audience,
  CampaignPlanRevision,
  CreateCampaignPlanRevisionInput,
} from "@tuezday/contracts";
import { Button } from "@/src/components/ui/button";
import { Input, Textarea } from "@/src/components/ui/input";
import { dateOnlyToTimestamp, timestampToDateOnly } from "@/lib/campaign-control-plane";
import styles from "../campaign-workspace.module.css";

interface CampaignPlanFormProps {
  initial: CampaignPlanRevision | null;
  audiences: Audience[];
  busy: boolean;
  onCancel(): void;
  onSubmit(input: CreateCampaignPlanRevisionInput): Promise<void>;
}

function lines(value: string): string[] {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

export function CampaignPlanForm({
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

  function toggleAudience(id: string) {
    setAudienceIds((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const start = dateOnlyToTimestamp(startAt);
    const end = dateOnlyToTimestamp(endAt);
    if (start !== null && end !== null && end <= start) {
      setError("Campaign end must be after its start.");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        objective,
        kpi,
        timeframe,
        startAt: start,
        endAt: end,
        audienceIds,
        pillars: lines(pillars).slice(0, 20),
        offers: lines(offers).slice(0, 20),
        ctas: lines(ctas).slice(0, 20),
        guidance,
      });
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
      {error && <p className="error" role="alert">{error}</p>}
      <div className={styles.formActions}>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create draft revision"}</Button>
        <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
