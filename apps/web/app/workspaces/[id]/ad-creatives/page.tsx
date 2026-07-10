"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import styles from "./ad-creatives.module.css";
import { Input, Textarea, Select } from "@/src/components/ui/input";


import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AD_CREATIVE_FORMATS,
  AD_CREATIVE_TASK_TYPES,
  formatAdCreative,
  parseAdCreative,
  type AdCreativeFieldValue,
  type AdCreativeTaskType,
  type AdCreativeViolation,
  type ApprovalState,
  type Campaign,
  type Draft,
  type Persona,
  type Workspace,
} from "@tuezday/contracts";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  edited: "Edited",
  approved: "Approved",
  rejected: "Rejected",
};

const STATE_TONES: Record<ApprovalState, "draft" | "pending" | "edited" | "approved" | "rejected"> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

interface SetDraft extends Draft {
  violations: AdCreativeViolation[];
}

interface AdTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

interface CreativeSet {
  generationId: string;
  taskType: AdCreativeTaskType;
  campaignId: string | null;
  campaignName: string | null;
  personaId: string | null;
  createdAt: number;
  drafts: SetDraft[];
  adMetrics: { totals: AdTotals; adCampaigns: { currency: string }[] } | null;
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function fieldLabel(taskType: AdCreativeTaskType, field: AdCreativeFieldValue): string {
  const spec = AD_CREATIVE_FORMATS[taskType].fields.find((f) => f.key === field.key);
  if (!spec) return field.key;
  return spec.maxCount > 1 ? `${spec.label} ${field.index}` : spec.label;
}

function maxCharsFor(taskType: AdCreativeTaskType, key: string): number {
  return AD_CREATIVE_FORMATS[taskType].fields.find((f) => f.key === key)?.maxChars ?? 0;
}

export default function AdCreativesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sets, setSets] = useState<CreativeSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // generate controls
  const [taskType, setTaskType] = useState<AdCreativeTaskType>("meta_ad_creative");
  const [campaignId, setCampaignId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [variantCount, setVariantCount] = useState(
    AD_CREATIVE_FORMATS.meta_ad_creative.variantCount!.default,
  );

  // per-draft field editor
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<AdCreativeFieldValue[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // export controls
  const [exportTaskType, setExportTaskType] = useState<AdCreativeTaskType>("meta_ad_creative");
  const [exportState, setExportState] = useState<ApprovalState>("approved");

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, pRes, sRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/ad-creatives`),
      ]);
      if (!wsRes.ok || !cRes.ok || !pRes.ok || !sRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setCampaigns(await cRes.json());
      setPersonas(await pRes.json());
      setSets(await sRes.json());
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCampaigns = useMemo(
    () => campaigns.filter((c) => c.status === "active"),
    [campaigns],
  );
  const selectedCampaignId = campaignId || activeCampaigns[0]?.id || "";
  const format = AD_CREATIVE_FORMATS[taskType];

  async function post(path: string, payload?: Record<string, unknown>) {
    const res = await apiFetch(`/workspaces/${id}${path}`, {
      method: "POST",
      ...(payload
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
    return body;
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await post("/ad-creatives/generate", {
        taskType,
        campaignId: selectedCampaignId,
        ...(personaId ? { personaId } : {}),
        ...(format.variantCount ? { variantCount } : {}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function draftAction(draftId: string, name: string, payload?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await post(`/drafts/${draftId}/${name}`, payload);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${name}`);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(set: CreativeSet, draft: SetDraft) {
    const parsed = parseAdCreative(set.taskType, draft.content);
    if (!parsed) {
      setError("This draft is not parseable — edit it as raw text in the Review queue.");
      return;
    }
    setEditingId(draft.id);
    setEditFields(parsed.fields);
  }

  function saveEdit(set: CreativeSet) {
    // Re-number multi-occurrence fields sequentially so removals leave no gaps.
    const renumbered: AdCreativeFieldValue[] = [];
    for (const spec of AD_CREATIVE_FORMATS[set.taskType].fields) {
      const values = editFields.filter((f) => f.key === spec.key);
      values.forEach((value, i) =>
        renumbered.push({ ...value, index: spec.maxCount > 1 ? i + 1 : 1 }),
      );
    }
    void draftAction(editingId!, "edit", {
      content: formatAdCreative(set.taskType, renumbered),
    });
  }

  async function copyDraft(draft: SetDraft) {
    await navigator.clipboard.writeText(draft.content);
    setCopiedId(draft.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function personaName(pid: string | null): string {
    if (!pid) return "org voice";
    return personas.find((p) => p.id === pid)?.name ?? "deleted persona";
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
      <PageHeader
        title="Ad creatives"
        subtitle="Platform-ready ad copy from your brain — generated as variant sets, reviewed like everything else, and exported within each platform's character limits."
      />

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-generating" size="sm" />
              Generate a variant set
            </span>
          }
        />
        {activeCampaigns.length === 0 ? (
          <EmptyState description={<>Ad creative is generated for a campaign — the campaign overlay drives the offer and
            angle. <Link href={`/workspaces/${id}/campaigns`}>Create a campaign first</Link>.</>} />
        ) : (
          <div className="resolve-controls">
            <label>
              Campaign
              <Select value={selectedCampaignId} onChange={(e) => setCampaignId(e.target.value)}>
                {activeCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Platform
              <Select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as AdCreativeTaskType)}
              >
                {AD_CREATIVE_TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {AD_CREATIVE_FORMATS[t].label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Persona
              <Select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                <option value="">org voice</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            {format.variantCount && (
              <label>
                Variants
                <Input
                  type="number"
                  min={format.variantCount.min}
                  max={format.variantCount.max}
                  value={variantCount}
                  onChange={(e) => setVariantCount(Number(e.target.value))}
                  style={{ width: 64 }}
                />
              </label>
            )}
            <Button variant="primary" disabled={busy || !selectedCampaignId} onClick={generate}>
              {busy ? "Working…" : "Generate"}
            </Button>
          </div>
        )}
        <p className="meta">
          {format.variantCount
            ? "Meta: primary text ≤125, headline ≤40, description ≤30 characters — display-safe limits, enforced before approval."
            : "Google RSA: up to 15 headlines ≤30 chars and 4 descriptions ≤90 chars in one asset set, enforced before approval."}
        </p>
        {error && <p className="error">{error}</p>}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="ad" size="sm" />
              Variant sets{" "}
              {sets.length > 0 && <CountBadge count={sets.length} label="creative variant sets" />}
            </span>
          }
          actions={
            sets.length > 0 && (
              <div className="resolve-controls" style={{ marginLeft: "auto" }}>
                <Select
                  value={exportTaskType}
                  onChange={(e) => setExportTaskType(e.target.value as AdCreativeTaskType)}
                >
                  {AD_CREATIVE_TASK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {AD_CREATIVE_FORMATS[t].label}
                    </option>
                  ))}
                </Select>
                <Select
                  value={exportState}
                  onChange={(e) => setExportState(e.target.value as ApprovalState)}
                >
                  <option value="approved">approved</option>
                  <option value="edited">edited</option>
                  <option value="pending_review">pending review</option>
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() =>
                    void apiDownload(
                      `/workspaces/${id}/ad-creatives/export.csv?taskType=${exportTaskType}&state=${exportState}`,
                      "ad-creatives.csv",
                    )
                  }
                >
                  ↓ Export CSV
                </Button>
              </div>
            )
          }
        />

        {sets.length === 0 ? (
          <EmptyState
            title="No ad creative yet"
            description="Pick a campaign above and generate a set — variants arrive within each platform's character limits, ready for review and CSV export."
            preview={
              <ul className="section-list">
                {[
                  { format: "Meta ad creative", title: "“Your GTM stack, minus 8 tools”", state: "approved" },
                  { format: "Google RSA", title: "“AI content that knows your company”", state: "pending_review" },
                ].map((s) => (
                  <li key={s.title} className="section-card">
                    <div className="section-head">
                      <span className="layer-badge">{s.format}</span>
                      <span className="section-title">{s.title}</span>
                      <span className={`layer-badge state-${s.state}`}>{s.state.replace("_", " ")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            }
          />
        ) : (
          <ul className="section-list">
            {sets.map((set) => {
              const currency = set.adMetrics?.adCampaigns[0]?.currency ?? "USD";
              return (
                <li key={set.generationId} className="section-card">
                  <div className="section-head">
                    <span className="section-title">
                      {AD_CREATIVE_FORMATS[set.taskType].label}
                      {set.campaignName && (
                        <span className="layer-badge layer-campaign" style={{ marginLeft: 8 }}>
                          {set.campaignName}
                        </span>
                      )}
                    </span>
                    <span className="meta">{personaName(set.personaId)}</span>
                    <span className="section-tokens">
                      {new Date(set.createdAt).toLocaleString()}
                    </span>
                  </div>

                  {set.adMetrics && (
                    <p className="section-reason">
                      Paid performance (linked ad campaigns, all time):{" "}
                      {money(set.adMetrics.totals.spendCents, currency)} spend ·{" "}
                      {set.adMetrics.totals.impressions.toLocaleString()} impressions ·{" "}
                      {set.adMetrics.totals.clicks.toLocaleString()} clicks ·{" "}
                      {set.adMetrics.totals.conversions} conversions ·{" "}
                      <Link href={`/workspaces/${id}/ads`}>open ads report</Link>
                    </p>
                  )}

                  <ul className="section-list" style={{ marginTop: 10 }}>
                    {set.drafts.map((draft) => {
                      const editable = draft.state === "pending_review" || draft.state === "edited";
                      const isEditing = editingId === draft.id;
                      const parsed = parseAdCreative(set.taskType, draft.content);
                      return (
                        <li key={draft.id} className="section-card">
                          <div className="section-head">
                            <Badge tone={STATE_TONES[draft.state]}>
                              {STATE_LABELS[draft.state]}
                            </Badge>
                            {draft.violations.length > 0 && (
                              <span className="layer-badge" style={{ background: "#7f1d1d" }}>
                                over limit
                              </span>
                            )}
                          </div>

                          {isEditing ? (
                            <div className="doc-editor" style={{ marginTop: 10 }}>
                              {AD_CREATIVE_FORMATS[set.taskType].fields.map((spec) => {
                                const values = editFields.filter((f) => f.key === spec.key);
                                return (
                                  <div key={spec.key}>
                                    {values.map((field, i) => {
                                      const over = field.value.length > spec.maxChars;
                                      const at = editFields.indexOf(field);
                                      return (
                                        <label key={`${spec.key}-${i}`} style={{ display: "block", marginBottom: 6 }}>
                                          <span className="meta">
                                            {spec.maxCount > 1 ? `${spec.label} ${i + 1}` : spec.label}{" "}
                                            <span style={{ color: over ? "#f87171" : undefined }}>
                                              {field.value.length}/{spec.maxChars}
                                            </span>
                                          </span>
                                          <div style={{ display: "flex", gap: 6 }}>
                                            {spec.key === "primary_text" ? (
                                              <Textarea
                                                rows={3}
                                                value={field.value}
                                                onChange={(e) =>
                                                  setEditFields((fields) =>
                                                    fields.map((f, j) =>
                                                      j === at ? { ...f, value: e.target.value } : f,
                                                    ),
                                                  )
                                                }
                                              />
                                            ) : (
                                              <Input
                                                value={field.value}
                                                onChange={(e) =>
                                                  setEditFields((fields) =>
                                                    fields.map((f, j) =>
                                                      j === at ? { ...f, value: e.target.value } : f,
                                                    ),
                                                  )
                                                }
                                              />
                                            )}
                                            {spec.maxCount > 1 && values.length > spec.minCount && (
                                              <Button
                                                variant="secondary"
                                                size="sm"
                                                title={`Remove this ${spec.label.toLowerCase()}`}
                                                onClick={() =>
                                                  setEditFields((fields) =>
                                                    fields.filter((_, j) => j !== at),
                                                  )
                                                }
                                              >
                                                ✕
                                              </Button>
                                            )}
                                          </div>
                                        </label>
                                      );
                                    })}
                                    {spec.maxCount > 1 && values.length < spec.maxCount && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setEditFields((fields) => [
                                            ...fields,
                                            { key: spec.key, index: values.length + 1, value: "" },
                                          ])
                                        }
                                      >
                                        + add {spec.label.toLowerCase()}
                                      </Button>
                                    )}
                                  </div>
                                );
                              })}
                              <div className="editor-actions">
                                <Button variant="primary" disabled={busy} onClick={() => saveEdit(set)}>
                                  Save edit
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => setEditingId(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {parsed ? (
                                <dl className="ad-creative-fields" style={{ margin: "8px 0" }}>
                                  {parsed.fields.map((field, i) => {
                                    const max = maxCharsFor(set.taskType, field.key);
                                    const over = field.value.length > max;
                                    return (
                                      <div key={i} style={{ marginBottom: 4 }}>
                                        <span className="meta">
                                          {fieldLabel(set.taskType, field)}{" "}
                                          <span style={{ color: over ? "#f87171" : undefined }}>
                                            {field.value.length}/{max}
                                          </span>
                                        </span>
                                        <div style={{ whiteSpace: "pre-wrap" }}>{field.value}</div>
                                      </div>
                                    );
                                  })}
                                </dl>
                              ) : (
                                <pre className="output-text">{draft.content}</pre>
                              )}
                              {draft.violations.length > 0 && (
                                <p className="error">
                                  {draft.violations.map((v) => v.message).join(" ")} Edit to fit
                                  before approving.
                                </p>
                              )}
                              <div className="rating-row">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => copyDraft(draft)}
                                >
                                  {copiedId === draft.id ? "✓ Copied" : "⧉ Copy"}
                                </Button>
                                {editable && (
                                  <>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      className="rating-accepted"
                                      disabled={busy || draft.violations.length > 0}
                                      onClick={() => draftAction(draft.id, "approve")}
                                    >
                                      ✓ Approve
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      disabled={busy}
                                      onClick={() => startEdit(set, draft)}
                                    >
                                      ✎ Edit
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      className="rating-rejected"
                                      disabled={busy}
                                      onClick={() => draftAction(draft.id, "reject")}
                                    >
                                      ✗ Reject
                                    </Button>
                                    {draft.state === "edited" && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => draftAction(draft.id, "resubmit")}
                                      >
                                        ↺ Resubmit
                                      </Button>
                                    )}
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
