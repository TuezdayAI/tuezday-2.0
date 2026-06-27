"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ApprovalState, Campaign, Draft, Lead, Persona, Workspace } from "@tuezday/contracts";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

const CSV_EXAMPLE = `name,email,company,role,notes
Asha Patel,asha@acme.io,Acme Robotics,Head of Growth,"Complained about AI slop on LinkedIn"`;

export default function OutboundPage() {
  const { id } = useParams<{ id: string }>();

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

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const approvedCount = drafts.filter((d) => d.state === "approved").length;

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
      <PageHeader title="Audience" subtitle={<>Your leads and contacts, with outreach drafted in your voice per person. Drafts go
            through Review; sending stays in your sender of choice.</>} actions={<>
            {approvedCount > 0 && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void apiDownload(`/workspaces/${id}/outbound/export.csv`, "outbound.csv")}
            >
              ↓ Export approved CSV ({approvedCount})
            </button>
          )}
          </>} />

      <section className="panel">
        <div className="panel-title-row">
          <h2>Leads ({leadsList.length})</h2>
          <button className="button-secondary" onClick={() => setShowAddForm(!showAddForm)}>
            + Add one lead
          </button>
        </div>

        <form
          className="persona-form"
          style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void importCsv();
          }}
        >
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={`Paste a CSV of leads…\n\n${CSV_EXAMPLE}`}
            rows={4}
          />
          <div className="editor-actions">
            <button type="submit" disabled={busy || csv.trim().length === 0}>
              Import CSV
            </button>
            {importResult && <span className="meta">{importResult}</span>}
          </div>
        </form>

        {showAddForm && (
          <form className="persona-form" onSubmit={addLead}>
            <div className="resolve-controls">
              <label style={{ flex: 1 }}>
                Name
                <input
                  value={newLead.name}
                  onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
                />
              </label>
              <label style={{ flex: 1 }}>
                Email
                <input
                  value={newLead.email}
                  onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
                />
              </label>
              <label>
                Company
                <input
                  value={newLead.company}
                  onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
                />
              </label>
              <label>
                Role
                <input
                  value={newLead.role}
                  onChange={(e) => setNewLead({ ...newLead, role: e.target.value })}
                />
              </label>
            </div>
            <input
              value={newLead.notes}
              onChange={(e) => setNewLead({ ...newLead, notes: e.target.value })}
              placeholder="Notes — what do you actually know about them?"
            />
            <input
              value={newLead.xHandle}
              onChange={(e) => setNewLead({ ...newLead, xHandle: e.target.value })}
              placeholder="X (Twitter) handle for DMs — e.g. @founder (optional)"
            />
            <div className="editor-actions">
              <button type="submit" disabled={busy}>
                Add lead
              </button>
            </div>
          </form>
        )}
        {error && <p className="error">{error}</p>}

        {leadsList.length === 0 ? (
          <EmptyState description={<>No leads yet. Paste a CSV above.</>} />
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
                    <button className="link-button" onClick={() => editHandle(lead)}>
                      {lead.xHandle ? "edit X handle" : "+ X handle"}
                    </button>
                    <button className="link-button" onClick={() => removeLead(lead)}>
                      delete
                    </button>
                  </div>
                  {lead.notes && <p className="section-reason">{lead.notes}</p>}
                  {chain.length > 0 && (
                    <ul className="draft-chain">
                      {chain.map((d) => (
                        <li key={d.id}>
                          <span className={`layer-badge state-${d.state}`}>
                            {STATE_LABELS[d.state]}
                          </span>{" "}
                          <span className="meta">{d.content.slice(0, 70)}…</span>{" "}
                          <Link className="link-button" href={`/workspaces/${id}/approvals`}>
                            open in queue
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Draft outbound emails</h2>
        <div className="resolve-controls">
          <label>
            Persona
            <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="">(none — org voice)</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {campaigns.length > 0 && (
            <label>
              Campaign
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">(no campaign)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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
          <button disabled={drafting || selectedCount === 0} onClick={draftEmails}>
            {drafting
              ? "Drafting…"
              : `Draft ${selectedCount || ""} personalized email${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
        {draftSummary && <p className="bundle-summary">{draftSummary}</p>}
      </section>
    </>
  );
}
