"use client";

// Sprint 48 — Outreach sequences surface. A first-class, always-on email
// sequence: point it at a live segment, define ordered steps on a delay, send
// from a mailbox pool, and enrollees auto-stop when they reply. Conceptually
// the sibling of Launches (S30), but a standalone email-only engine.

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import { Tabs } from "@/src/components/ui/tabs";
import styles from "./outreach.module.css";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AUTOMATION_MODES,
  OUTREACH_DEFAULT_ENROLLMENT_CAP,
  OUTREACH_MAX_ENROLLMENT_CAP,
  OUTREACH_MAX_STEPS,
  OUTREACH_ENROLLMENT_OUTCOMES,
  type Audience,
  type AutomationMode,
  type Campaign,
  type FunnelSlice,
  type MailboxWithUsage,
  type OutreachEnrollment,
  type OutreachEnrollmentOutcome,
  type OutreachEnrollmentStatus,
  type OutreachFunnel,
  type OutreachSequence,
  type OutreachSequenceDetail,
  type OutreachSequenceStatus,
  type Persona,
  type Workspace,
} from "@tuezday/contracts";

const MODE_LABELS: Record<AutomationMode, string> = {
  manual: "Manual (you drive every step)",
  human_in_the_loop: "Review each step (auto-generates, waits at the gate)",
  scheduled_auto: "Fully automated (generates, approves & sends on schedule)",
};

const SEQUENCE_STATUS_TONE: Record<
  OutreachSequenceStatus,
  "draft" | "approved" | "edited" | "neutral"
> = {
  draft: "draft",
  active: "approved",
  paused: "edited",
  completed: "neutral",
};

const ENROLLMENT_STATUS_TONE: Record<
  OutreachEnrollmentStatus,
  "neutral" | "approved" | "rejected" | "danger" | "draft"
> = {
  active: "neutral",
  replied: "approved",
  stopped: "rejected",
  failed: "danger",
  completed: "draft",
};

const ENROLLMENT_STATUS_LABEL: Record<OutreachEnrollmentStatus, string> = {
  active: "active",
  replied: "replied — stopped",
  stopped: "stopped",
  failed: "failed",
  completed: "completed",
};

// Manual funnel outcome (Sprint 50) — the tail every enrollment carries.
const OUTCOME_TONE: Record<
  OutreachEnrollmentOutcome,
  "neutral" | "approved" | "pending" | "rejected" | "draft"
> = {
  none: "draft",
  meeting: "pending",
  won: "approved",
  lost: "rejected",
};

const OUTCOME_LABEL: Record<OutreachEnrollmentOutcome, string> = {
  none: "no outcome",
  meeting: "meeting",
  won: "won",
  lost: "lost",
};

// Rates arrive as fractions (0..1) — render as whole percents, matching insights.
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

// Sample sequences for the preview-value empty state — blurred behind the CTA.
const SAMPLE_SEQUENCES = [
  { name: "Fintech VPs — nurture", status: "active", detail: "3 steps · 42 enrolled" },
  { name: "Design leaders — cold intro", status: "draft", detail: "2 steps · not started" },
  { name: "Q3 re-engagement", status: "paused", detail: "4 steps · 18 enrolled" },
];

function formatDue(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function OutreachPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sequences, setSequences] = useState<OutreachSequence[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxWithUsage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    campaignId: string;
    personaId: string;
    audienceId: string;
    goal: string;
    automationMode: AutomationMode;
    dailyEnrollmentCap: string;
    stopOnReply: boolean;
    trackOpens: boolean;
    trackClicks: boolean;
  }>({
    name: "",
    campaignId: "",
    personaId: "",
    audienceId: "",
    goal: "",
    automationMode: "manual",
    dailyEnrollmentCap: String(OUTREACH_DEFAULT_ENROLLMENT_CAP),
    stopOnReply: true,
    trackOpens: false,
    trackClicks: false,
  });
  const [saving, setSaving] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OutreachSequenceDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, sRes, cRes, pRes, aRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/outreach-sequences`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/audiences`),
      ]);
      if (!wsRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      // The route may not be live yet — treat a 404 as an empty list.
      setSequences(sRes.ok ? ((await sRes.json()) as OutreachSequence[]) : []);
      setCampaigns(
        cRes.ok ? ((await cRes.json()) as Campaign[]).filter((c) => c.status === "active") : [],
      );
      setPersonas(pRes.ok ? ((await pRes.json()) as Persona[]) : []);
      setAudiences(aRes.ok ? ((await aRes.json()) as Audience[]) : []);
      // Mailboxes are optional — Gmail may not be connected yet.
      try {
        const mRes = await apiFetch(`/workspaces/${id}/mailboxes`);
        setMailboxes(
          mRes.ok
            ? ((await mRes.json()) as MailboxWithUsage[]).filter((m) => m.status === "connected")
            : [],
        );
      } catch {
        setMailboxes([]);
      }
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(seqId: string) {
    if (openId === seqId) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(seqId);
    setDetail(null);
    const res = await apiFetch(`/workspaces/${id}/outreach-sequences/${seqId}`);
    if (res.ok) setDetail(await res.json());
  }

  async function refreshDetail(seqId: string) {
    const res = await apiFetch(`/workspaces/${id}/outreach-sequences/${seqId}`);
    if (res.ok) setDetail(await res.json());
    await load();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cap = Number.parseInt(form.dailyEnrollmentCap, 10);
      const res = await apiFetch(`/workspaces/${id}/outreach-sequences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          campaignId: form.campaignId,
          personaId: form.personaId,
          audienceId: form.audienceId,
          goal: form.goal.trim() || undefined,
          automationMode: form.automationMode,
          dailyEnrollmentCap: Number.isInteger(cap) ? cap : undefined,
          stopOnReply: form.stopOnReply,
          trackOpens: form.trackOpens,
          trackClicks: form.trackClicks,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setShowForm(false);
      setForm({
        name: "",
        campaignId: "",
        personaId: "",
        audienceId: "",
        goal: "",
        automationMode: "manual",
        dailyEnrollmentCap: String(OUTREACH_DEFAULT_ENROLLMENT_CAP),
        stopOnReply: true,
        trackOpens: false,
        trackClicks: false,
      });
      await load();
      // Jump straight into the new sequence so the founder can add steps.
      if (body?.id) await openDetail(body.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create sequence");
    } finally {
      setSaving(false);
    }
  }

  async function remove(seq: OutreachSequence) {
    if (!confirm(`Delete outreach sequence "${seq.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/outreach-sequences/${seq.id}`, { method: "DELETE" });
    if (openId === seq.id) {
      setOpenId(null);
      setDetail(null);
    }
    await load();
  }

  const createDisabled =
    saving || !form.name || !form.campaignId || !form.personaId || !form.audienceId;

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }
  if (!workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <PageHeader
        title="Outreach"
        subtitle={
          <>
            Always-on email sequences. Point one at a live segment — people auto-enroll, receive
            brain-resolved steps on a delay from your mailbox pool, and the chain stops the moment
            they reply. Every step clears Review first.
          </>
        }
      />

      <TopBarActions>
        <Button variant="primary" size="compact" onClick={() => setShowForm(!showForm)}>
          <Icon name="add" size="compact" /> New sequence
        </Button>
      </TopBarActions>

      {error && <p className="error">{error}</p>}

      {mailboxes.length === 0 && (
        <p className="meta" style={{ marginBottom: 8 }}>
          No connected mailbox yet — connect Gmail under Integrations to send outreach. You can still
          draft a sequence now.
        </p>
      )}

      {showForm && (
        <Card>
          <CardHeader
            title={
              <span className={styles.cardTitle}>
                <Icon name="add" size="compact" /> New sequence
              </span>
            }
          />
          <form className="persona-form" onSubmit={create}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Sequence name — e.g. Fintech VPs nurture"
              maxLength={200}
            />
            <div className="resolve-controls">
              <label>
                Campaign
                <Select
                  value={form.campaignId}
                  onChange={(e) => setForm({ ...form, campaignId: e.target.value })}
                >
                  <option value="">(pick an active campaign)</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Persona
                <Select
                  value={form.personaId}
                  onChange={(e) => setForm({ ...form, personaId: e.target.value })}
                >
                  <option value="">(pick a persona / voice)</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Segment / list
                <Select
                  value={form.audienceId}
                  onChange={(e) => setForm({ ...form, audienceId: e.target.value })}
                >
                  <option value="">(pick a segment / list)</option>
                  {audiences.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.memberCount})
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <Input
              value={form.goal}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
              placeholder="Goal — a human-readable label, e.g. book a demo (optional)"
              maxLength={500}
            />
            <div className="resolve-controls">
              <label>
                Automation
                <Select
                  value={form.automationMode}
                  onChange={(e) =>
                    setForm({ ...form, automationMode: e.target.value as AutomationMode })
                  }
                >
                  {AUTOMATION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Daily enrollment cap
                <Input
                  type="number"
                  min={1}
                  max={OUTREACH_MAX_ENROLLMENT_CAP}
                  value={form.dailyEnrollmentCap}
                  onChange={(e) => setForm({ ...form, dailyEnrollmentCap: e.target.value })}
                  style={{ width: 110 }}
                />
              </label>
              <label className="checkbox-label" style={{ alignSelf: "flex-end" }}>
                <input
                  type="checkbox"
                  checked={form.stopOnReply}
                  onChange={(e) => setForm({ ...form, stopOnReply: e.target.checked })}
                />
                Stop on reply
              </label>
            </div>
            <div className={styles.trackingRow}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.trackOpens}
                  onChange={(e) => setForm({ ...form, trackOpens: e.target.checked })}
                />
                Track opens
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.trackClicks}
                  onChange={(e) => setForm({ ...form, trackClicks: e.target.checked })}
                />
                Track clicks
              </label>
            </div>
            <p className="meta">
              Tracking is off by default. Turning it on sends an HTML email (open pixel + rewritten
              links), which can reduce deliverability — opt in only when you need the funnel.
            </p>
            <div className="editor-actions">
              <Button type="submit" variant="primary" disabled={createDisabled}>
                {saving ? "Creating…" : "Create sequence"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader
          title={
            <span className={styles.cardTitle}>
              <Icon name="email" size="compact" /> Sequences
              <CountBadge count={sequences.length} label="outreach sequences" />
            </span>
          }
        />
        {sequences.length === 0 ? (
          <EmptyState
            preview={
              <ul className="section-list">
                {SAMPLE_SEQUENCES.map((s) => (
                  <li key={s.name} className="section-card">
                    <div className="section-head">
                      <span className="section-title">{s.name}</span>
                      <span className={`layer-badge state-${s.status}`}>{s.status}</span>
                      <span className="meta">{s.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            }
            icon={<Icon name="email" size="emphasized" />}
            title="Turn one send into an always-on sequence"
            description={
              <>
                Point a sequence at a live segment: people auto-enroll, receive brain-resolved steps
                on a delay from your mailbox pool, and the chain stops when they reply. Every step
                clears Review first.
              </>
            }
            primaryAction={
              <Button variant="primary" size="compact" onClick={() => setShowForm(true)}>
                <Icon name="add" size="compact" /> New sequence
              </Button>
            }
          />
        ) : (
          <ul className="section-list">
            {sequences.map((seq) => (
              <li key={seq.id} className="section-card">
                <div className="section-head">
                  <Button variant="tertiary" size="compact" onClick={() => openDetail(seq.id)}>
                    <span className="section-title">{seq.name}</span>
                  </Button>
                  <Badge tone={SEQUENCE_STATUS_TONE[seq.status]}>{seq.status}</Badge>
                  <span className="meta">
                    {MODE_LABELS[seq.automationMode].split(" (")[0]}
                    {seq.goal ? ` · ${seq.goal}` : ""}
                  </span>
                  <Button variant="danger" size="compact" onClick={() => remove(seq)}>
                    delete
                  </Button>
                </div>

                {openId === seq.id && detail && (
                  <OutreachDetailView
                    workspaceId={id}
                    detail={detail}
                    mailboxes={mailboxes}
                    onChanged={() => refreshDetail(seq.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail: config, mailbox pool, step editor, activate/pause, enrollments.
// ---------------------------------------------------------------------------

interface EditStep {
  instruction: string;
  delayHours: number;
}

function OutreachDetailView({
  workspaceId,
  detail,
  mailboxes,
  onChanged,
}: {
  workspaceId: string;
  detail: OutreachSequenceDetail;
  mailboxes: MailboxWithUsage[];
  onChanged: () => void;
}) {
  const seq = detail;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Set when activation is blocked because the workspace has no CAN-SPAM postal
  // address yet (409 compliance_address_missing) — points to Integrations.
  const [complianceMissing, setComplianceMissing] = useState(false);

  const call = async (
    path: string,
    init: RequestInit,
    okMessage: string,
  ): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    setValidationError(null);
    setComplianceMissing(false);
    try {
      const res = await apiFetch(
        `/workspaces/${workspaceId}/outreach-sequences/${seq.id}${path}`,
        init,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && body?.error === "compliance_address_missing") {
          setComplianceMissing(true);
          throw new Error(
            "Set your business mailing address in settings before activating.",
          );
        }
        throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      }
      setNote(okMessage);
      onChanged();
      return true;
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const activate = () => call("/activate", { method: "POST" }, "Sequence activated.");
  const pause = () => call("/pause", { method: "POST" }, "Sequence paused.");

  const enrolledCount = seq.enrollments.length;
  const canActivateHint =
    seq.steps.length === 0
      ? "Add at least one step before activating."
      : seq.mailboxIds.length === 0
        ? "Add at least one mailbox to the pool before activating."
        : null;

  return (
    <div className={styles.detail}>
      <div className="section-head" style={{ gap: 10 }}>
        <span className="meta">
          {seq.steps.length} step(s) · {seq.mailboxIds.length} mailbox(es) · {enrolledCount}{" "}
          enrolled · cap {seq.dailyEnrollmentCap}/day · stop-on-reply{" "}
          {seq.stopOnReply ? "on" : "off"} · tracking{" "}
          {seq.trackOpens || seq.trackClicks
            ? [seq.trackOpens ? "opens" : null, seq.trackClicks ? "clicks" : null]
                .filter(Boolean)
                .join(" + ")
            : "off"}
        </span>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          {seq.status !== "active" && (
            <Button
              variant="primary"
              size="compact"
              disabled={busy}
              onClick={activate}
              title={canActivateHint ?? undefined}
            >
              Activate
            </Button>
          )}
          {seq.status === "active" && (
            <Button variant="secondary" size="compact" disabled={busy} onClick={pause}>
              Pause
            </Button>
          )}
        </div>
      </div>

      {note && <p className="bundle-summary">{note}</p>}
      {validationError && (
        <p className={styles.validationError}>
          {validationError}
          {complianceMissing && (
            <>
              {" "}
              <Link href={`/workspaces/${workspaceId}/connectors`}>
                Open compliance settings →
              </Link>
            </>
          )}
        </p>
      )}
      {canActivateHint && seq.status !== "active" && (
        <p className="meta">{canActivateHint}</p>
      )}

      <TrackingSettings workspaceId={workspaceId} sequence={seq} onChanged={onChanged} />

      <FunnelWidget workspaceId={workspaceId} sequence={seq} />

      <MailboxPool
        workspaceId={workspaceId}
        sequence={seq}
        mailboxes={mailboxes}
        onChanged={onChanged}
      />

      <StepEditor workspaceId={workspaceId} sequence={seq} onChanged={onChanged} />

      <EnrollmentsTable
        workspaceId={workspaceId}
        sequence={seq}
        mailboxes={mailboxes}
        onChanged={onChanged}
      />
    </div>
  );
}

function MailboxPool({
  workspaceId,
  sequence,
  mailboxes,
  onChanged,
}: {
  workspaceId: string;
  sequence: OutreachSequenceDetail;
  mailboxes: MailboxWithUsage[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(sequence.mailboxIds.map((mid) => [mid, true])),
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setSelected(Object.fromEntries(sequence.mailboxIds.map((mid) => [mid, true])));
  }, [sequence.mailboxIds]);

  const chosen = Object.keys(selected).filter((k) => selected[k]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(
        `/workspaces/${workspaceId}/outreach-sequences/${sequence.id}/mailboxes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailboxIds: chosen }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote("Mailbox pool saved.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to save the pool");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className={styles.cardTitle}>
            <Icon name="email" size="compact" /> Mailbox pool
          </span>
        }
      />
      <p className="meta">
        Sequences send from a pool — start with one. Each enrollment pins the least-loaded mailbox
        for thread continuity.
      </p>
      {mailboxes.length === 0 ? (
        <p className="meta">No connected mailbox yet — connect Gmail under Integrations.</p>
      ) : (
        <div className={styles.poolGrid}>
          {mailboxes.map((m) => (
            <label key={m.id} className="checkbox-label">
              <input
                type="checkbox"
                checked={!!selected[m.id]}
                onChange={(e) => setSelected({ ...selected, [m.id]: e.target.checked })}
              />
              {m.address}
              <span className="meta">
                {" "}
                ({m.sentToday}/{m.dailyCap} today)
              </span>
            </label>
          ))}
        </div>
      )}
      {note && <p className="bundle-summary">{note}</p>}
      <div className="editor-actions" style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          size="compact"
          disabled={busy || chosen.length === 0}
          onClick={save}
        >
          Save pool ({chosen.length})
        </Button>
      </div>
    </Card>
  );
}

function StepEditor({
  workspaceId,
  sequence,
  onChanged,
}: {
  workspaceId: string;
  sequence: OutreachSequenceDetail;
  onChanged: () => void;
}) {
  const seed = useCallback((): EditStep[] => {
    const sorted = [...sequence.steps].sort((a, b) => a.stepNumber - b.stepNumber);
    if (sorted.length === 0) return [{ instruction: "", delayHours: 0 }];
    return sorted.map((s) => ({ instruction: s.instruction, delayHours: s.delayHours }));
  }, [sequence.steps]);

  const [steps, setSteps] = useState<EditStep[]>(seed);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setSteps(seed());
  }, [seed]);

  const setField = (i: number, patch: Partial<EditStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const addStep = () =>
    setSteps((prev) =>
      prev.length >= OUTREACH_MAX_STEPS ? prev : [...prev, { instruction: "", delayHours: 48 }],
    );
  const removeLast = () => setSteps((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      // Steps are contiguous 1..N; step 1 always has delay 0.
      const payload = steps.map((s, i) => ({
        stepNumber: i + 1,
        instruction: s.instruction,
        delayHours: i === 0 ? 0 : Number(s.delayHours) || 0,
      }));
      const res = await apiFetch(
        `/workspaces/${workspaceId}/outreach-sequences/${sequence.id}/steps`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steps: payload }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote("Steps saved.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to save steps");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className={styles.cardTitle}>
            <Icon name="calendar" size="compact" /> Steps
          </span>
        }
      />
      <p className="meta">
        Up to {OUTREACH_MAX_STEPS} ordered steps. Step 1 sends on enroll; each follow-up fires the
        given hours after the previous. Leave the angle blank to let the model write a natural
        follow-up.
      </p>
      <ol className={styles.stepList}>
        {steps.map((s, i) => (
          <li key={i} className="section-card">
            <div className={styles.stepRow}>
              <div className={styles.stepHead}>
                <span className={styles.stepNum}>Step {i + 1}</span>
                {i === 0 ? (
                  <span className="meta">sends on enroll (no delay)</span>
                ) : (
                  <label className="meta" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    Delay (hours after previous)
                    <Input
                      type="number"
                      min={0}
                      max={8760}
                      value={s.delayHours}
                      onChange={(e) => setField(i, { delayHours: Number(e.target.value) })}
                      style={{ width: 90 }}
                    />
                  </label>
                )}
              </div>
              <Textarea
                value={s.instruction}
                onChange={(e) => setField(i, { instruction: e.target.value })}
                placeholder={
                  i === 0
                    ? "First touch angle (optional) — leave blank for a natural cold open"
                    : "Follow-up angle (optional) — e.g. add the case study"
                }
                rows={2}
                maxLength={1000}
                style={{ width: "100%" }}
              />
            </div>
          </li>
        ))}
      </ol>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          variant="tertiary"
          size="compact"
          disabled={steps.length >= OUTREACH_MAX_STEPS}
          onClick={addStep}
        >
          + add step
        </Button>
        {steps.length > 1 && (
          <Button variant="tertiary" size="compact" onClick={removeLast}>
            remove last
          </Button>
        )}
      </div>
      {note && <p className="bundle-summary">{note}</p>}
      <div className="editor-actions" style={{ marginTop: 8 }}>
        <Button variant="primary" size="compact" disabled={busy} onClick={save}>
          Save steps
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tracking toggle (Sprint 50) — opt-in open/click tracking, saved via PATCH.
// ---------------------------------------------------------------------------

function TrackingSettings({
  workspaceId,
  sequence,
  onChanged,
}: {
  workspaceId: string;
  sequence: OutreachSequenceDetail;
  onChanged: () => void;
}) {
  const [trackOpens, setTrackOpens] = useState(sequence.trackOpens);
  const [trackClicks, setTrackClicks] = useState(sequence.trackClicks);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setTrackOpens(sequence.trackOpens);
    setTrackClicks(sequence.trackClicks);
  }, [sequence.trackOpens, sequence.trackClicks]);

  const dirty = trackOpens !== sequence.trackOpens || trackClicks !== sequence.trackClicks;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/outreach-sequences/${sequence.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackOpens, trackClicks }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote("Tracking saved.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to save tracking");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className={styles.cardTitle}>
            <Icon name="status-learning" size="compact" /> Tracking
          </span>
        }
      />
      <div className={styles.trackingRow}>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={trackOpens}
            onChange={(e) => setTrackOpens(e.target.checked)}
          />
          Track opens
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={trackClicks}
            onChange={(e) => setTrackClicks(e.target.checked)}
          />
          Track clicks
        </label>
      </div>
      <p className="meta">
        Off by default. Tracking sends an HTML email (invisible open pixel + rewritten links), which
        can reduce deliverability — opt in only when you need the funnel. Opens are a soft signal:
        Apple Mail Privacy Protection inflates them.
      </p>
      {note && <p className="bundle-summary">{note}</p>}
      <div className="editor-actions" style={{ marginTop: 8 }}>
        <Button variant="primary" size="compact" disabled={busy || !dirty} onClick={save}>
          Save tracking
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Funnel + attribution (Sprint 50) — computed on read; hidden when unavailable.
// ---------------------------------------------------------------------------

const FUNNEL_STAGES: {
  key: "sent" | "opened" | "clicked" | "replied" | "positive" | "meetings";
  label: string;
  rate?: "openRate" | "clickRate" | "replyRate" | "positiveRate";
  soft?: boolean;
}[] = [
  { key: "sent", label: "Sent" },
  { key: "opened", label: "Opened", rate: "openRate", soft: true },
  { key: "clicked", label: "Clicked", rate: "clickRate" },
  { key: "replied", label: "Replied", rate: "replyRate" },
  { key: "positive", label: "Positive", rate: "positiveRate" },
  { key: "meetings", label: "Meetings" },
];

function FunnelWidget({
  workspaceId,
  sequence,
}: {
  workspaceId: string;
  sequence: OutreachSequenceDetail;
}) {
  const [funnel, setFunnel] = useState<OutreachFunnel | null>(null);
  // null = still loading; false = route absent / tracking never on → hide entirely.
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    setFunnel(null);
    apiFetch(`/workspaces/${workspaceId}/outreach-sequences/${sequence.id}/funnel`)
      .then(async (res) => {
        if (cancelled) return;
        // 404 → route not live yet, or nothing tracked; degrade gracefully.
        if (!res.ok) {
          setAvailable(false);
          return;
        }
        setFunnel((await res.json()) as OutreachFunnel);
        setAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sequence.id]);

  // Hide the widget outright when the funnel can't be shown.
  if (available === false || (available === null && !funnel)) return null;
  if (!funnel) return null;

  return (
    <Card>
      <CardHeader
        title={
          <span className={styles.cardTitle}>
            <Icon name="status-learning" size="compact" /> Funnel
          </span>
        }
      />
      <div className={styles.funnelRow}>
        {FUNNEL_STAGES.map((stage) => (
          <div key={stage.key} className={styles.funnelStage}>
            <span className={styles.funnelCount}>{funnel[stage.key]}</span>
            <span className={styles.funnelLabel}>
              {stage.label}
              {stage.soft && (
                <span
                  className={styles.softHint}
                  title="Soft signal — inflated by Apple Mail Privacy Protection, which pre-fetches the pixel"
                >
                  soft
                </span>
              )}
            </span>
            {stage.rate && <span className="meta">{pct(funnel[stage.rate])}</span>}
          </div>
        ))}
      </div>
      <p className="meta">
        Opens are a soft signal — inflated by Apple Mail Privacy Protection. Ranking leans on clicks
        and replies.
      </p>

      <AttributionTable attribution={funnel.attribution} />
    </Card>
  );
}

function AttributionTable({
  attribution,
}: {
  attribution: OutreachFunnel["attribution"];
}) {
  const [tab, setTab] = useState<"byStep" | "byPersona" | "bySegment">("byStep");
  const rows: FunnelSlice[] = attribution[tab] ?? [];

  return (
    <div className={styles.attribution}>
      <Tabs
        tabs={[
          { key: "byStep", label: "By step" },
          { key: "byPersona", label: "By persona" },
          { key: "bySegment", label: "By segment" },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />
      {rows.length === 0 ? (
        <p className="meta">No attribution rows yet.</p>
      ) : (
        <div className={styles.enrollTableWrap}>
          <table className={styles.enrollTable}>
            <thead>
              <tr>
                <th>{tab === "byStep" ? "Step" : tab === "byPersona" ? "Persona" : "Segment"}</th>
                <th>Sent</th>
                <th>Replied</th>
                <th>Reply rate</th>
                <th>Positive</th>
                <th>Positive rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className={styles.enrollEmail}>{r.label}</td>
                  <td>{r.sent}</td>
                  <td>{r.replied}</td>
                  <td>{r.sent > 0 ? pct(r.replied / r.sent) : "—"}</td>
                  <td>{r.positive}</td>
                  <td>{r.sent > 0 ? pct(r.positive / r.sent) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EnrollmentsTable({
  workspaceId,
  sequence,
  mailboxes,
  onChanged,
}: {
  workspaceId: string;
  sequence: OutreachSequenceDetail;
  mailboxes: MailboxWithUsage[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const enrollments = sequence.enrollments;

  const mailboxAddress = (mid: string | null): string =>
    mid ? (mailboxes.find((m) => m.id === mid)?.address ?? "—") : "—";

  async function stop(payload: Record<string, unknown>, okMessage: string) {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(
        `/workspaces/${workspaceId}/outreach-sequences/${sequence.id}/stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "manual", ...payload }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote(okMessage);
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to stop");
    } finally {
      setBusy(false);
    }
  }

  async function setOutcome(enrollmentId: string, outcome: OutreachEnrollmentOutcome) {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(
        `/workspaces/${workspaceId}/outreach-sequences/${sequence.id}/enrollments/${enrollmentId}/outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setNote("Outcome updated.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to set outcome");
    } finally {
      setBusy(false);
    }
  }

  const activeCount = enrollments.filter((e) => e.status === "active").length;

  if (enrollments.length === 0) {
    return (
      <Card>
        <CardHeader
          title={
            <span className={styles.cardTitle}>
              <Icon name="audience" size="compact" /> Enrollments
            </span>
          }
        />
        <p className="meta">
          No one enrolled yet. Activate the sequence — matching segment members enroll on the next
          run.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className={styles.cardTitle}>
            <Icon name="audience" size="compact" /> Enrollments
            <CountBadge count={enrollments.length} label="enrollments" />
          </span>
        }
      />
      <div className={styles.enrollTableWrap}>
        <table className={styles.enrollTable}>
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Step</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>Next due</th>
              <th>Mailbox</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {enrollments.map((e: OutreachEnrollment) => (
              <tr key={e.id}>
                <td className={styles.enrollEmail}>{e.recipientEmail || "—"}</td>
                <td>{e.currentStep}</td>
                <td>
                  <Badge tone={ENROLLMENT_STATUS_TONE[e.status]}>
                    {ENROLLMENT_STATUS_LABEL[e.status]}
                  </Badge>
                </td>
                <td>
                  <div className={styles.outcomeCell}>
                    <Badge tone={OUTCOME_TONE[e.outcome]}>{OUTCOME_LABEL[e.outcome]}</Badge>
                    <Select
                      aria-label="Set outcome"
                      value={e.outcome}
                      disabled={busy}
                      onChange={(ev) =>
                        setOutcome(e.id, ev.target.value as OutreachEnrollmentOutcome)
                      }
                      className={styles.outcomeSelect}
                    >
                      {OUTREACH_ENROLLMENT_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABEL[o]}
                        </option>
                      ))}
                    </Select>
                  </div>
                </td>
                <td>{e.status === "active" ? formatDue(e.nextDueAt) : "—"}</td>
                <td>{mailboxAddress(e.mailboxId)}</td>
                <td>
                  {e.status === "active" && (
                    <Button
                      variant="tertiary"
                      size="compact"
                      disabled={busy}
                      onClick={() => stop({ enrollmentIds: [e.id] }, "Recipient stopped.")}
                    >
                      stop
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="bundle-summary">{note}</p>}
      <div className={styles.enrollActions}>
        <Button
          variant="danger"
          size="compact"
          disabled={busy || activeCount === 0}
          onClick={() => stop({ all: true }, "Stopped all active recipients.")}
        >
          Stop all active ({activeCount})
        </Button>
      </div>
    </Card>
  );
}
