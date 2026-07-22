"use client";

import { useMemo, useState } from "react";
import type {
  Audience,
  CampaignLaneRevisionView,
  Channel,
  Connection,
  DeliveryMode,
  LaneStatus,
  Persona,
  ReactivePeriod,
  UpsertCampaignLaneRevisionInput,
} from "@tuezday/contracts";
import { Button } from "@/src/components/ui/button";
import { Input, Select } from "@/src/components/ui/input";
import styles from "../campaign-workspace.module.css";

interface CampaignLaneFormProps {
  initial: CampaignLaneRevisionView | null;
  campaignChannels: Channel[];
  personas: Persona[];
  audiences: Audience[];
  connections: Connection[];
  busy: boolean;
  onCancel(): void;
  onSubmit(input: UpsertCampaignLaneRevisionInput): Promise<void>;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

export function CampaignLaneForm({
  initial,
  campaignChannels,
  personas,
  audiences,
  connections,
  busy,
  onCancel,
  onSubmit,
}: CampaignLaneFormProps) {
  const defaultChannel = initial?.channel ?? campaignChannels[0] ?? "linkedin";
  const [name, setName] = useState(initial?.name ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [personaId, setPersonaId] = useState(initial?.personaId ?? personas[0]?.id ?? "");
  const [audienceId, setAudienceId] = useState(initial?.audienceId ?? "");
  const [channel, setChannel] = useState<Channel>(defaultChannel);
  const [format, setFormat] = useState(initial?.format ?? `${defaultChannel}_post`);
  const [publishingConnectionId, setPublishingConnectionId] = useState(
    initial?.publishingConnectionId ?? "",
  );
  const [providerTarget, setProviderTarget] = useState(initial?.providerTarget ?? "");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(
    initial?.deliveryMode ?? "planned",
  );
  const [plannedQuantity, setPlannedQuantity] = useState(initial?.plannedQuantity ?? 1);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial?.schedule?.daysOfWeek ?? [1]);
  const [timeOfDay, setTimeOfDay] = useState(initial?.schedule?.timeOfDay ?? "09:00");
  const [timezone, setTimezone] = useState(
    initial?.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [reactivePeriod, setReactivePeriod] = useState<ReactivePeriod>(
    initial?.reactivePeriod ?? "week",
  );
  const [reactiveCap, setReactiveCap] = useState(initial?.reactiveCap ?? 1);
  const [status, setStatus] = useState<LaneStatus>(initial?.status ?? "active");
  const [error, setError] = useState<string | null>(null);

  const connectionOptions = useMemo(
    () => connections.filter(
      (connection) =>
        connection.status === "connected" || connection.id === publishingConnectionId,
    ),
    [connections, publishingConnectionId],
  );

  function toggleDay(day: number) {
    setDaysOfWeek((current) =>
      current.includes(day) ? current.filter((candidate) => candidate !== day) : [...current, day].sort(),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const stableKey = initial?.key ?? (key || slug(name));
    if (!name.trim() || !stableKey || !personaId || !format.trim()) {
      setError("Name, key, persona, and format are required.");
      return;
    }
    if (deliveryMode !== "reactive" && (plannedQuantity < 1 || daysOfWeek.length === 0)) {
      setError("Planned delivery needs a positive quantity and at least one schedule day.");
      return;
    }
    if (deliveryMode !== "planned" && reactiveCap < 1) {
      setError("Reactive delivery needs a positive cap.");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        laneId: initial?.laneId,
        key: stableKey,
        name: name.trim(),
        personaId,
        audienceId: audienceId || null,
        channel,
        format: format.trim(),
        publishingConnectionId: publishingConnectionId || null,
        providerTarget: providerTarget.trim(),
        deliveryMode,
        plannedQuantity: deliveryMode === "reactive" ? 0 : plannedQuantity,
        schedule:
          deliveryMode === "reactive"
            ? null
            : { daysOfWeek, timeOfDay, timezone: timezone.trim() || "UTC" },
        reactivePeriod: deliveryMode === "planned" ? null : reactivePeriod,
        reactiveCap: deliveryMode === "planned" ? null : reactiveCap,
        status,
      });
    } catch {
      // The parent owns API errors so the form stays open with its values preserved.
    }
  }

  return (
    <form className={styles.laneForm} onSubmit={submit}>
      <p className={styles.mobilePlanningNote}>
        Channel planning is easier on a wider screen. Your place and current values are preserved.
      </p>
      <div className={styles.formColumns}>
        <label>
          <span>Lane name</span>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!initial) setKey(slug(event.target.value));
            }}
            placeholder="Founder LinkedIn"
          />
        </label>
        <label><span>Stable key</span><Input value={key} onChange={(event) => setKey(slug(event.target.value))} disabled={Boolean(initial)} /></label>
        <label>
          <span>Persona</span>
          <Select value={personaId} onChange={(event) => setPersonaId(event.target.value)}>
            <option value="">Choose a persona</option>
            {personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
          </Select>
        </label>
        <label>
          <span>Audience</span>
          <Select value={audienceId} onChange={(event) => setAudienceId(event.target.value)}>
            <option value="">No lane-specific audience</option>
            {audiences.map((audience) => <option key={audience.id} value={audience.id}>{audience.name}</option>)}
          </Select>
        </label>
        <label>
          <span>Channel</span>
          <Select value={channel} onChange={(event) => setChannel(event.target.value as Channel)}>
            {(campaignChannels.length ? campaignChannels : [defaultChannel]).map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </label>
        <label><span>Format</span><Input value={format} onChange={(event) => setFormat(event.target.value)} placeholder="linkedin_post" /></label>
        <label>
          <span>Publishing connection</span>
          <Select value={publishingConnectionId} onChange={(event) => setPublishingConnectionId(event.target.value)}>
            <option value="">Select later</option>
            {connectionOptions.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}{connection.status !== "connected" ? " · connection lost" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label><span>Provider target</span><Input value={providerTarget} onChange={(event) => setProviderTarget(event.target.value)} placeholder="feed, page, list…" /></label>
        <label>
          <span>Delivery mode</span>
          <Select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)}>
            <option value="planned">Planned</option>
            <option value="reactive">Reactive</option>
            <option value="planned_and_reactive">Planned and reactive</option>
          </Select>
        </label>
        <label>
          <span>Status</span>
          <Select value={status} onChange={(event) => setStatus(event.target.value as LaneStatus)}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            {initial?.status === "retired" && <option value="retired">Retired</option>}
          </Select>
        </label>
      </div>

      {deliveryMode !== "reactive" && (
        <fieldset className={styles.scheduleFields}>
          <legend>Planned schedule</legend>
          <label><span>Quantity</span><Input type="number" min={1} max={1000} value={plannedQuantity} onChange={(event) => setPlannedQuantity(Number(event.target.value))} /></label>
          <div className={styles.dayChoices}>
            {DAYS.map((label, day) => (
              <label key={label}><input type="checkbox" checked={daysOfWeek.includes(day)} onChange={() => toggleDay(day)} /><span>{label}</span></label>
            ))}
          </div>
          <label><span>Time</span><Input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} /></label>
          <label><span>Timezone</span><Input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
        </fieldset>
      )}

      {deliveryMode !== "planned" && (
        <fieldset className={styles.scheduleFields}>
          <legend>Reactive allowance</legend>
          <label><span>Maximum</span><Input type="number" min={1} max={1000} value={reactiveCap} onChange={(event) => setReactiveCap(Number(event.target.value))} /></label>
          <label>
            <span>Period</span>
            <Select value={reactivePeriod} onChange={(event) => setReactivePeriod(event.target.value as ReactivePeriod)}>
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </Select>
          </label>
        </fieldset>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className={styles.formActions}>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save channel"}</Button>
        <Button variant="tertiary" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
