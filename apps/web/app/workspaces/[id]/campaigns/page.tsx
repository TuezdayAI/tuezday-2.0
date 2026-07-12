"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import { Icon } from "@/src/components/ui/icon";
import { SettingsModal } from "@/src/components/ui/settings-modal";
import { toast } from "@/src/components/ui/toast";
import { TopBarActions } from "@/src/components/top-bar";
import { AutomationGuardrails } from "../automation/guardrails";
import { CadenceManager } from "../cadence/cadence-manager";
import styles from "./campaigns.module.css";

import { API_URL, apiFetch, apiDownload } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  type ApprovalState,
  type AutomationMode,
  type Campaign,
  type CampaignPurpose,
  type CampaignStatus,
  type Channel,
  type Persona,
  type Workspace,
  type CampaignInsights,
} from "@tuezday/contracts";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

const AUTOMATION_LABELS: Record<AutomationMode, string> = {
  manual: "Manual",
  human_in_the_loop: "Human-in-the-loop",
  scheduled_auto: "Scheduled-auto",
};

const AUTOMATION_HINTS: Record<AutomationMode, string> = {
  manual: "You generate, approve, and publish by hand.",
  human_in_the_loop: "New signals draft to each channel and wait in Review for your approval.",
  scheduled_auto:
    "New signals draft, auto-approve, and post on this campaign's cadence — within the Automation guardrails.",
};

interface AdTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

interface CampaignDetail {
  campaign: Campaign;
  draftCounts: Record<ApprovalState, number>;
  drafts: { id: string; state: ApprovalState; taskType: string; channel: string; createdAt: number }[];
  adMetrics: {
    totals: AdTotals;
    adCampaigns: { id: string; name: string; accountName: string; currency: string; totals: AdTotals }[];
  } | null;
  audiences: { id: string; name: string; kind: "static" | "dynamic"; memberCount: number }[];
  insights?: CampaignInsights;
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const EMPTY_FORM = {
  name: "",
  objective: "",
  kpi: "",
  timeframe: "",
  audience: "",
  pillarsText: "",
  channels: [] as Channel[],
  personaIds: [] as string[],
  overlay: "",
};

export default function CampaignsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [details, setDetails] = useState<Record<string, CampaignDetail>>({});
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [step, setStep] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Module settings (spec §3.2): cadence + automation guardrails in a modal.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("automation");

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, cRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
      ]);
      if (!wsRes.ok || !pRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setPersonas(await pRes.json());
      setCampaignsList(await cRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(c?: Campaign) {
    setShowForm(true);
    setStep(1);
    setEditingId(c?.id ?? null);
    setForm(
      c
        ? {
            name: c.name,
            objective: c.objective,
            kpi: c.kpi,
            timeframe: c.timeframe,
            audience: c.audience,
            pillarsText: c.pillars.join("\n"),
            channels: c.channels,
            personaIds: c.personaIds,
            overlay: c.overlay,
          }
        : EMPTY_FORM,
    );
  }

  function payloadFromForm(
    status: CampaignStatus = "active",
    purpose: CampaignPurpose = "initiative",
  ) {
    return {
      name: form.name,
      objective: form.objective,
      kpi: form.kpi,
      timeframe: form.timeframe,
      audience: form.audience,
      pillars: form.pillarsText
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 10),
      channels: form.channels,
      personaIds: form.personaIds,
      overlay: form.overlay,
      purpose,
      status,
    };
  }

  async function saveCampaign(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const editing = editingId ? campaignsList.find((c) => c.id === editingId) : undefined;
      const url = editingId
        ? `/workspaces/${id}/campaigns/${editingId}`
        : `/workspaces/${id}/campaigns`;
      const res = await apiFetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          payloadFromForm(editing?.status ?? "active", editing?.purpose ?? "initiative"),
        ),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setShowForm(false);
      setDetails({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save campaign");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(c: Campaign, status: "active" | "archived") {
    await apiFetch(`/workspaces/${id}/campaigns/${c.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: c.name,
        purpose: c.purpose,
        objective: c.objective,
        kpi: c.kpi,
        timeframe: c.timeframe,
        audience: c.audience,
        pillars: c.pillars,
        channels: c.channels,
        personaIds: c.personaIds,
        overlay: c.overlay,
        status,
      }),
    });
    await load();
  }

  async function saveAutomation(
    c: Campaign,
    automationMode: AutomationMode,
    autoDailyCap: number | null,
  ) {
    await apiFetch(`/workspaces/${id}/campaigns/${c.id}/automation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automationMode, autoDailyCap }),
    });
    await load();
  }

  async function toggleDetail(campaignId: string) {
    if (expandedId === campaignId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(campaignId);
    if (!details[campaignId]) {
      const [res, insightsRes] = await Promise.all([
        apiFetch(`/workspaces/${id}/campaigns/${campaignId}`),
        apiFetch(`/workspaces/${id}/campaigns/${campaignId}/insights`)
      ]);
      if (res.ok) {
        const detail = await res.json();
        let insights = undefined;
        if (insightsRes.ok) {
          insights = await insightsRes.json();
        }
        setDetails((d) => ({ ...d, [campaignId]: { ...detail, insights } }));
      }
    }
  }

  function toggleInList<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

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
      <TopBarActions>
        <Button variant="primary" size="sm" onClick={() => startEdit()}>
          <Icon name="add" size="sm" /> New campaign
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          <Icon name="module-settings" size="sm" /> Settings
        </Button>
      </TopBarActions>

      <div className="page-header">
        <div>
          <h1>Campaigns</h1>
          <p className="subtitle">
            Your GTM goals and everything attached to them. A campaign shapes every draft created
            under it.
          </p>
        </div>
      </div>

      {showForm && (
        <Card>
          <CardHeader
            title={
              <>
                <span className={styles.detailLabel}>
                  <Icon name="campaigns" size="sm" /> {editingId ? "Edit campaign" : "New campaign"}
                </span>
                <span style={{ fontSize: "0.8rem", color: "var(--color-fg-muted)", marginLeft: "1rem", fontWeight: "normal" }}>
                  Step {step} of 3
                </span>
              </>
            }
          />
          <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={saveCampaign}>
            {step === 1 && (
              <>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Campaign name (e.g. Q3 GTM memory push)"
                  maxLength={200}
                />
                <Textarea
                  value={form.objective}
                  onChange={(e) => setForm({ ...form, objective: e.target.value })}
                  placeholder="Objective — what is this campaign trying to achieve?"
                  rows={2}
                />
                <div className="resolve-controls">
                  <label style={{ flex: 1 }}>
                    KPI
                    <Input
                      value={form.kpi}
                      onChange={(e) => setForm({ ...form, kpi: e.target.value })}
                      placeholder="e.g. 20 demo calls booked"
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    Timeframe
                    <Input
                      value={form.timeframe}
                      onChange={(e) => setForm({ ...form, timeframe: e.target.value })}
                      placeholder="e.g. Jul–Sep 2026"
                    />
                  </label>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <Textarea
                  value={form.audience}
                  onChange={(e) => setForm({ ...form, audience: e.target.value })}
                  placeholder="Audience slice — who exactly is this for?"
                  rows={2}
                />
                <Textarea
                  value={form.pillarsText}
                  onChange={(e) => setForm({ ...form, pillarsText: e.target.value })}
                  placeholder={"Messaging pillars — one per line (max 10)"}
                  rows={3}
                />
              </>
            )}

            {step === 3 && (
              <>
                <div className="checkbox-row">
                  <span className="meta">Channels:</span>
                  {CHANNELS.map((c) => (
                    <label key={c} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.channels.includes(c)}
                        onChange={() => setForm({ ...form, channels: toggleInList(form.channels, c) })}
                      />
                      {c}
                    </label>
                  ))}
                </div>
                {personas.length > 0 && (
                  <div className="checkbox-row">
                    <span className="meta">Personas:</span>
                    {personas.map((p) => (
                      <label key={p.id} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={form.personaIds.includes(p.id)}
                          onChange={() =>
                            setForm({ ...form, personaIds: toggleInList(form.personaIds, p.id) })
                          }
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                )}
                <Textarea
                  value={form.overlay}
                  onChange={(e) => setForm({ ...form, overlay: e.target.value })}
                  placeholder="Campaign now-overlay — what matters for this campaign right now (markdown)…"
                  rows={4}
                />
              </>
            )}

            <div className="editor-actions">
              {step > 1 && (
                <Button variant="secondary" size="sm" type="button" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              )}
              {step < 3 ? (
                <Button variant="primary" type="button" onClick={() => setStep(step + 1)} disabled={form.name.trim().length === 0}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" type="submit" disabled={saving || form.name.trim().length === 0}>
                  {editingId ? "Update campaign" : "Create campaign"}
                </Button>
              )}
              <Button variant="secondary" size="sm" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </Card>
      )}

      {campaignsList.length === 0 && !showForm ? (
        <EmptyState
          icon={<Icon name="campaigns" size="lg" />}
          title="No campaigns yet"
          description="A campaign scopes goals, channels, and voice — every draft created under it inherits them."
          primaryAction={
            <Button variant="primary" onClick={() => startEdit()}>
              <Icon name="add" size="sm" /> New campaign
            </Button>
          }
        />
      ) : (
        <ul className="section-list">
          {campaignsList.map((c) => {
            const detail = details[c.id];
            return (
              <li key={c.id} className={`section-card ${c.status === "archived" ? "excluded" : ""}`}>
                <div className="section-head" onClick={() => toggleDetail(c.id)}>
                  <Badge tone={c.status === "active" ? "approved" : "neutral"}>
                    {c.status}
                  </Badge>
                  <span className="section-title">{c.name}</span>
                  <span className="section-tokens">{c.timeframe}</span>
                </div>
                {c.objective && <p className="section-reason">{c.objective}</p>}
                {c.pillars.length > 0 && (
                  <p className="section-reason">Pillars: {c.pillars.join(" · ")}</p>
                )}

                {expandedId === c.id && detail && (
                  <div className="campaign-detail">
                    <p className="bundle-summary">
                      <span className={styles.detailLabel}>
                        <Icon name="edit" size="sm" /> Drafts
                      </span>
                      {": "}
                      {(Object.keys(detail.draftCounts) as ApprovalState[])
                        .filter((s) => detail.draftCounts[s] > 0)
                        .map((s) => `${detail.draftCounts[s]} ${STATE_LABELS[s]}`)
                        .join(" · ") || "none yet"}
                    </p>
                    {detail.drafts.length > 0 && (
                      <ul className="draft-chain">
                        {detail.drafts.slice(0, 8).map((d) => (
                          <li key={d.id}>
                            <Badge tone={d.state === "pending_review" ? "pending" : d.state}>
                              {STATE_LABELS[d.state]}
                            </Badge>{" "}
                            <span className="meta">
                              {d.taskType} · {d.channel} ·{" "}
                              {new Date(d.createdAt).toLocaleDateString()}
                            </span>{" "}
                            <Link className="link-button" href={`/workspaces/${id}/approvals`}>
                              open queue
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    {detail.audiences.length > 0 && (
                      <p className="bundle-summary" style={{ marginTop: 10 }}>
                        <span className={styles.detailLabel}>
                          <Icon name="audience" size="sm" /> Audiences
                        </span>
                        {": "}
                        {detail.audiences
                          .map((a) => `${a.name} (${a.kind}, ${a.memberCount} members)`)
                          .join(" · ")}
                      </p>
                    )}
                    {detail.adMetrics && (
                      <>
                        <p className="bundle-summary" style={{ marginTop: 10 }}>
                          <span className={styles.detailLabel}>
                            <Icon name="ad" size="sm" /> Paid performance
                          </span>
                          {": "}
                          {money(
                            detail.adMetrics.totals.spendCents,
                            detail.adMetrics.adCampaigns[0]?.currency ?? "USD",
                          )}{" "}
                          spend · {detail.adMetrics.totals.impressions.toLocaleString()} impressions
                          · {detail.adMetrics.totals.clicks.toLocaleString()} clicks ·{" "}
                          {detail.adMetrics.totals.conversions} conversions
                        </p>
                        <ul className="draft-chain">
                          {detail.adMetrics.adCampaigns.map((ac) => (
                            <li key={ac.id}>
                              <span className="meta">
                                {ac.name} ({ac.accountName}) —{" "}
                                {money(ac.totals.spendCents, ac.currency)} ·{" "}
                                {ac.totals.impressions.toLocaleString()} imp ·{" "}
                                {ac.totals.clicks.toLocaleString()} clicks ·{" "}
                                {ac.totals.conversions} conv
                              </span>{" "}
                              <Link className="link-button" href={`/workspaces/${id}/ads`}>
                                open ads
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {detail.insights && (
                      <div className="bundle-summary" style={{ marginTop: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span className={styles.detailLabel}>
                            <Icon name="status-learning" size="sm" /> Campaign insights
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); apiDownload(`/workspaces/${id}/campaigns/${c.id}/insights?format=csv`, `campaign-insights-${c.id}.csv`); }}
                          >
                            Export CSV
                          </Button>
                        </div>
                        <ul className="draft-chain" style={{ marginTop: 4 }}>
                          <li><span className="meta">Published: {detail.insights.organic.publishedCount}</span></li>
                          <li><span className="meta">Sent/Outbound: {detail.insights.outbound.sentCount}</span></li>
                          <li><span className="meta">Approval Rate: {Math.round(detail.insights.quality.approvalRate * 100)}%</span></li>
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                <div
                  className="automation-row"
                  style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                >
                  <span className="meta">Automation:</span>
                  <Select
                    value={c.automationMode}
                    onChange={(e) =>
                      saveAutomation(c, e.target.value as AutomationMode, c.autoDailyCap)
                    }
                  >
                    {(Object.keys(AUTOMATION_LABELS) as AutomationMode[]).map((m) => (
                      <option key={m} value={m}>
                        {AUTOMATION_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                  {c.automationMode === "scheduled_auto" && (
                    <label className="meta" style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      Daily cap
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        defaultValue={c.autoDailyCap ?? ""}
                        placeholder="default"
                        style={{ width: 80 }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const cap = v === "" ? null : Math.max(1, Math.min(1000, Number(v)));
                          if (cap !== c.autoDailyCap) saveAutomation(c, c.automationMode, cap);
                        }}
                      />
                    </label>
                  )}
                  <span className="meta">{AUTOMATION_HINTS[c.automationMode]}</span>
                </div>

                <div className="rating-row" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => startEdit(c)}>
                    Edit
                  </Button>
                  {c.status === "active" ? (
                    <Button variant="secondary" size="sm" onClick={() => setStatus(c, "archived")}>
                      Archive
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setStatus(c, "active")}>
                      Unarchive
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Module settings (spec §3.2): how Campaigns behaves — posting cadence
          and the automation guardrails. Both reuse the real forms behind the
          /cadence and /automation routes; changes apply as you make them. */}
      <SettingsModal
        title="Campaign settings"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={() => {
          setSettingsOpen(false);
          toast("Settings saved");
        }}
        sections={[
          { id: "automation", label: "Automation guardrails" },
          { id: "cadence", label: "Posting cadence" },
        ]}
        activeSection={settingsSection}
        onSectionChange={setSettingsSection}
      >
        {settingsSection === "automation" ? (
          <>
            <p className={styles.settingsHint}>
              Limits for campaigns in an automated mode. Changes apply immediately — the same
              controls live on the Automation page.
            </p>
            <AutomationGuardrails workspaceId={id} />
          </>
        ) : (
          <>
            <p className={styles.settingsHint}>
              Recurring posting slots that approved drafts fill automatically. Changes apply
              immediately — the same controls live on the Cadence page.
            </p>
            <CadenceManager workspaceId={id} />
          </>
        )}
      </SettingsModal>
    </>
  );
}
