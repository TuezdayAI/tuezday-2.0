"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import {
  EmailPermissionControl,
  EmailSendStatus,
} from "@/src/components/email-send-status";
import styles from "./outbound.module.css";

import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type {
  ApprovalState,
  Campaign,
  Draft,
  EmailPermissionStatus,
  ExternalActionSubmission,
  Lead,
  Persona,
  Workspace,
} from "@tuezday/contracts";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

const STATE_TONES: Record<
  ApprovalState,
  "neutral" | "approved" | "pending" | "edited" | "rejected" | "draft" | "danger"
> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

/** Subject/body split for the email PreviewCard renderer (first line reads as the subject). */
function splitEmail(content: string): { title: string; body: string } {
  const lines = content.split("\n");
  const first = (lines[0] ?? "").replace(/^Subject:\s*/i, "").trim();
  if (!first) return { title: "Outbound email", body: content };
  return { title: first, body: lines.slice(1).join("\n").trim() };
}

const CSV_EXAMPLE = `name,email,company,role,notes
Asha Patel,asha@acme.io,Acme Robotics,Head of Growth,"Complained about AI slop on LinkedIn"`;

// Sample leads for the preview-value empty state (spec §5.7.3 / §6.5) —
// blurred behind the CTA, never shown as real data.
const SAMPLE_LEADS = [
  {
    name: "Asha Patel",
    email: "asha@acme.io",
    detail: "Head of Growth at Acme Robotics",
    state: "approved" as const,
    snippet: "Saw your post on AI slop — we obsess over the same thing…",
  },
  {
    name: "Diego Fernández",
    email: "diego@northbeam.co",
    detail: "Founder at Northbeam",
    state: "pending" as const,
    snippet: "Your teardown of attribution models made the rounds here…",
  },
  {
    name: "Mei Lin",
    email: "mei@driftline.io",
    detail: "VP Marketing at Driftline",
    state: "draft" as const,
    snippet: "Congrats on the Series A — the timing on lifecycle…",
  },
];

export default function OutboundPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [leadsList, setLeadsList] = useState<Lead[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [csv, setCsv] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLead, setNewLead] = useState({ name: "", email: "", company: "", role: "", notes: "", xHandle: "" });

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [personaId, setPersonaId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [useEvidence, setUseEvidence] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedDrafts, setSelectedDrafts] = useState<Record<string, boolean>>({});
  const [sendingDrafts, setSendingDrafts] = useState<Record<string, boolean>>({});
  const [sendSubmissions, setSendSubmissions] = useState<
    Record<string, ExternalActionSubmission>
  >({});
  const [sendSummary, setSendSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, lRes, pRes, cRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/leads`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/drafts`),
      ]);
      if (!wsRes.ok || !lRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setLeadsList(await lRes.json());
      setPersonas(await pRes.json());
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      setDrafts(((await dRes.json()) as Draft[]).filter((d) => d.leadId));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function importCsv() {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/leads/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setImportResult(
        `${body.imported} imported, ${body.skipped} skipped${body.errors.length ? ` — ${body.errors.join(" ")}` : ""}`,
      );
      setCsv("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function addLead(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newLead),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setNewLead({ name: "", email: "", company: "", role: "", notes: "", xHandle: "" });
      setShowAddForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add lead");
    } finally {
      setBusy(false);
    }
  }

  async function removeLead(lead: Lead) {
    if (!confirm(`Delete lead "${lead.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/leads/${lead.id}`, { method: "DELETE" });
    await load();
  }

  async function editHandle(lead: Lead) {
    const next = prompt(`X (Twitter) handle for ${lead.name} (without @):`, lead.xHandle ?? "");
    if (next === null) return;
    await apiFetch(`/workspaces/${id}/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xHandle: next }),
    });
    await load();
  }

  async function draftEmails() {
    const leadIds = Object.keys(selected).filter((k) => selected[k]);
    setDrafting(true);
    setError(null);
    setDraftSummary(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/outbound/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadIds,
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      const ok = body.results.filter((r: { draftId?: string }) => r.draftId).length;
      const failed = body.results.length - ok;
      setDraftSummary(
        `${ok} draft(s) sent to Review${failed ? `, ${failed} failed (retry those leads)` : ""}.`,
      );
      setSelected({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drafting failed");
    } finally {
      setDrafting(false);
    }
  }

  function draftsForLead(leadId: string): Draft[] {
    return drafts.filter((d) => d.leadId === leadId);
  }

  async function proposeDraftSend(draftId: string): Promise<ExternalActionSubmission> {
    setSendingDrafts((current) => ({ ...current, [draftId]: true }));
    try {
      const response = await apiFetch(`/workspaces/${id}/outbound/drafts/${draftId}/send`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | ExternalActionSubmission
        | { message?: string; error?: string }
        | null;
      if (!body || !("action" in body)) {
        throw new Error(body?.message ?? body?.error ?? "Native email send could not be proposed.");
      }
      setSendSubmissions((current) => ({ ...current, [draftId]: body }));
      return body;
    } finally {
      setSendingDrafts((current) => ({ ...current, [draftId]: false }));
    }
  }

  async function sendOneDraft(draftId: string) {
    setError(null);
    try {
      await proposeDraftSend(draftId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Native email send failed.");
    }
  }

  async function sendSelectedDrafts() {
    const draftIds = Object.keys(selectedDrafts).filter((draftId) => selectedDrafts[draftId]);
    setSendSummary(null);
    setError(null);
    const results = await Promise.all(
      draftIds.map(async (draftId) => {
        try {
          await proposeDraftSend(draftId);
          return { draftId, ok: true };
        } catch (sendError) {
          return {
            draftId,
            ok: false,
            error: sendError instanceof Error ? sendError.message : "Native email send failed.",
          };
        }
      }),
    );
    const sent = results.filter((result) => result.ok).length;
    const failed = results.length - sent;
    setSendSummary(
      `${sent} send action${sent === 1 ? "" : "s"} proposed${
        failed ? ` · ${failed} failed and can be retried individually` : ""
      }.`,
    );
    setSelectedDrafts({});
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const approvedCount = drafts.filter((d) => d.state === "approved").length;
  const selectedDraftCount = Object.values(selectedDrafts).filter(Boolean).length;

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
      <PageHeader title="Audience" subtitle={<>Your leads and contacts, with outreach drafted in your voice per person. Drafts clear
            Review before governed native email sending.</>} />

      <TopBarActions>
        {selectedDraftCount > 0 && (
          <Button
            type="button"
            variant="primary"
            size="standard"
            onClick={() => void sendSelectedDrafts()}
          >
            Send selected from Tuezday ({selectedDraftCount})
          </Button>
        )}
        {approvedCount > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => void apiDownload(`/workspaces/${id}/outbound/export.csv`, "outbound.csv")}
          >
            <Icon name="external" size="compact" /> Export approved CSV ({approvedCount})
          </Button>
        )}
      </TopBarActions>
      {sendSummary && <p className={styles.sendSummary} aria-live="polite">{sendSummary}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.cardTitle}>
              <Icon name="audience" size="compact" /> Leads
              <CountBadge count={leadsList.length} label="leads" />
            </span>
          }
          actions={
            <Button variant="secondary" size="compact" onClick={() => setShowAddForm(!showAddForm)}>
              <Icon name="add" size="compact" /> Add one lead
            </Button>
          }
        />

        <form
          className="persona-form"
          style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void importCsv();
          }}
        >
          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={`Paste a CSV of leads…\n\n${CSV_EXAMPLE}`}
            rows={4}
          />
          <div className="editor-actions">
            <Button type="submit" variant="primary" disabled={busy || csv.trim().length === 0}>
              Import CSV
            </Button>
            {importResult && <span className="meta">{importResult}</span>}
          </div>
        </form>

        {showAddForm && (
          <form className="persona-form" onSubmit={addLead}>
            <div className="resolve-controls">
              <label style={{ flex: 1 }}>
                Name
                <Input
                  value={newLead.name}
                  onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
                />
              </label>
              <label style={{ flex: 1 }}>
                Email
                <Input
                  value={newLead.email}
                  onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
                />
              </label>
              <label>
                Company
                <Input
                  value={newLead.company}
                  onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
                />
              </label>
              <label>
                Role
                <Input
                  value={newLead.role}
                  onChange={(e) => setNewLead({ ...newLead, role: e.target.value })}
                />
              </label>
            </div>
            <Input
              value={newLead.notes}
              onChange={(e) => setNewLead({ ...newLead, notes: e.target.value })}
              placeholder="Notes — what do you actually know about them?"
            />
            <Input
              value={newLead.xHandle}
              onChange={(e) => setNewLead({ ...newLead, xHandle: e.target.value })}
              placeholder="X (Twitter) handle for DMs — e.g. @founder (optional)"
            />
            <div className="editor-actions">
              <Button type="submit" variant="primary" disabled={busy}>
                Add lead
              </Button>
            </div>
          </form>
        )}
        {error && <p className="error">{error}</p>}

        {leadsList.length === 0 ? (
          <EmptyState
            preview={
              <ul className="section-list">
                {SAMPLE_LEADS.map((lead) => (
                  <li key={lead.email} className="section-card">
                    <div className="section-head">
                      <span className="section-title">
                        {lead.name} <span className="meta">&lt;{lead.email}&gt;</span>
                        <span className="meta"> — {lead.detail}</span>
                      </span>
                      <Badge tone={STATE_TONES[lead.state === "pending" ? "pending_review" : lead.state]}>
                        {lead.state}
                      </Badge>
                    </div>
                    <p className="section-reason">{lead.snippet}</p>
                  </li>
                ))}
              </ul>
            }
            title="Send approved sequences from your own sender"
            description={
              <>
                Paste a CSV of leads above — Tuezday drafts outreach in your voice, routes it
                through Review, and exports approved sequences to Smartlead or Instantly. Your
                sender keeps deliverability.
              </>
            }
            primaryAction={
              <Button
                variant="primary"
                size="compact"
                onClick={() => router.push(`/workspaces/${id}/connectors`)}
              >
                Open Integrations
              </Button>
            }
          />
        ) : (
          <ul className="section-list">
            {leadsList.map((lead) => {
              const chain = draftsForLead(lead.id);
              return (
                <li key={lead.id} className="section-card">
                  <div className="section-head">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={!!selected[lead.id]}
                        onChange={(e) =>
                          setSelected({ ...selected, [lead.id]: e.target.checked })
                        }
                      />
                    </label>
                    <span className="section-title">
                      {lead.name} <span className="meta">&lt;{lead.email}&gt;</span>
                      {(lead.role || lead.company) && (
                        <span className="meta">
                          {" "}
                          — {[lead.role, lead.company].filter(Boolean).join(" at ")}
                        </span>
                      )}
                      {lead.xHandle && <span className="meta"> · X @{lead.xHandle}</span>}
                    </span>
                    <Button variant="tertiary" size="compact" onClick={() => editHandle(lead)}>
                      {lead.xHandle ? "edit X handle" : "+ X handle"}
                    </Button>
                    <Button variant="danger" size="compact" onClick={() => removeLead(lead)}>
                      delete
                    </Button>
                  </div>
                  {lead.notes && <p className="section-reason">{lead.notes}</p>}
                  {chain.length > 0 && (
                    <div className={styles.previewGrid}>
                      {chain.map((d) => {
                        const { title, body } = splitEmail(d.content);
                        return (
                          <div className={styles.draftCard} key={d.id}>
                            <PreviewCard
                              kind="email"
                              title={title}
                              body={body}
                              scheduledAt={new Date(d.createdAt).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                              status={STATE_LABELS[d.state]}
                              statusTone={STATE_TONES[d.state]}
                              onOpen={() => router.push(`/workspaces/${id}/review`)}
                              actions={
                                <ButtonLink
                                  variant="tertiary"
                                  size="compact"
                                  href={`/workspaces/${id}/review`}
                                >
                                  open in queue
                                </ButtonLink>
                              }
                            />
                            {d.state === "approved" && (
                              <OutboundEmailControls
                                workspaceId={id}
                                lead={lead}
                                draft={d}
                                selected={Boolean(selectedDrafts[d.id])}
                                sending={Boolean(sendingDrafts[d.id])}
                                submission={sendSubmissions[d.id]}
                                onSelected={(checked) =>
                                  setSelectedDrafts((current) => ({
                                    ...current,
                                    [d.id]: checked,
                                  }))
                                }
                                onSend={() => void sendOneDraft(d.id)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.cardTitle}>
              <Icon name="email" size="compact" /> Draft outbound emails
            </span>
          }
        />
        <div className="resolve-controls">
          <label>
            Persona
            <Select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="">(none — org voice)</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          {campaigns.length > 0 && (
            <label>
              Campaign
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">(no campaign)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="checkbox-label" style={{ alignSelf: "center" }}>
            <input
              type="checkbox"
              checked={useEvidence}
              onChange={(e) => setUseEvidence(e.target.checked)}
            />
            Use evidence
          </label>
          <Button variant="primary" disabled={drafting || selectedCount === 0} onClick={draftEmails}>
            {drafting
              ? "Drafting…"
              : `Draft ${selectedCount || ""} personalized email${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
        {draftSummary && <p className="bundle-summary">{draftSummary}</p>}
      </Card>
    </>
  );
}

function OutboundEmailControls({
  workspaceId,
  lead,
  draft,
  selected,
  sending,
  submission,
  onSelected,
  onSend,
}: {
  workspaceId: string;
  lead: Lead;
  draft: Draft;
  selected: boolean;
  sending: boolean;
  submission?: ExternalActionSubmission;
  onSelected: (checked: boolean) => void;
  onSend: () => void;
}) {
  const [permission, setPermission] = useState<EmailPermissionStatus>("unknown");

  useEffect(() => {
    let current = true;
    void apiFetch(
      `/workspaces/${workspaceId}/email-permissions/${encodeURIComponent(lead.email)}`,
    )
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { status: EmailPermissionStatus };
        if (current) setPermission(body.status);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [lead.email, workspaceId]);

  return (
    <div className={styles.sendControls}>
      <EmailPermissionControl
        workspaceId={workspaceId}
        email={lead.email}
        status={permission}
        onChange={(next) => {
          setPermission(next);
          if (next !== "allowed") onSelected(false);
        }}
      />
      <div className={styles.sendActions}>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={selected}
            disabled={permission !== "allowed" || sending}
            onChange={(event) => onSelected(event.target.checked)}
          />
          Select this approved draft
        </label>
        <Button
          variant="primary"
          size="standard"
          loading={sending}
          disabled={permission !== "allowed"}
          onClick={onSend}
        >
          Send from Tuezday
        </Button>
      </div>
      {submission && <EmailSendStatus submission={submission} delivery={null} />}
      <span className={styles.draftId}>Draft {draft.id}</span>
    </div>
  );
}
