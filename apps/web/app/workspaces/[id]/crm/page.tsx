"use client";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  Connection,
  ConnectorProvider,
  CrmContact,
  Draft,
  Lead,
  Workspace,
} from "@tuezday/contracts";

interface ConnectorsView {
  providers: ConnectorProvider[];
  connections: Connection[];
  fabric: { healthy: boolean; detail?: string };
}

interface ContactView extends CrmContact {
  lead: { id: string; name: string } | null;
}

interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  truncated: boolean;
}

export default function CrmPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [leadsList, setLeadsList] = useState<Lead[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [connectionId, setConnectionId] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [logged, setLogged] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, ctRes, lRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/crm/contacts`),
        apiFetch(`/workspaces/${id}/leads`),
        apiFetch(`/workspaces/${id}/drafts`),
      ]);
      if (!wsRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await cRes.json());
      setContacts(await ctRes.json());
      setLeadsList(await lRes.json());
      setDrafts(((await dRes.json()) as Draft[]).filter((d) => d.leadId));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const crmConnections = useMemo(() => {
    if (!view) return [];
    const crmProviderKeys = new Set(
      view.providers.filter((p) => p.categories?.includes("crm")).map((p) => p.key),
    );
    return view.connections.filter(
      (c) => crmProviderKeys.has(c.providerKey) && c.status === "connected",
    );
  }, [view]);

  const activeConnectionId = connectionId || crmConnections[0]?.id || "";
  const linkedLeadIds = useMemo(
    () => new Set(contacts.filter((c) => c.leadId).map((c) => c.leadId as string)),
    [contacts],
  );
  const approvedDrafts = drafts.filter((d) => d.state === "approved");

  function providerLabel(providerKey: string): string {
    return view?.providers.find((p) => p.key === providerKey)?.label ?? providerKey;
  }

  async function post(path: string, payload?: Record<string, unknown>) {
    const res = await apiFetch(`/workspaces/${id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
    return body;
  }

  async function sync() {
    setBusy(true);
    setError(null);
    setSyncResult(null);
    try {
      setSyncResult(await post("/crm/sync", { connectionId: activeConnectionId }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function importLead(contact: ContactView) {
    setBusy(true);
    setError(null);
    try {
      await post(`/crm/contacts/${contact.id}/import-lead`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function pushLead(lead: Lead) {
    setBusy(true);
    setError(null);
    try {
      await post("/crm/push-lead", { leadId: lead.id, connectionId: activeConnectionId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Push failed");
    } finally {
      setBusy(false);
    }
  }

  async function logDraft(draft: Draft) {
    setBusy(true);
    setError(null);
    try {
      await post("/crm/log-draft", { draftId: draft.id });
      setLogged((prev) => ({ ...prev, [draft.id]: new Date().toLocaleTimeString() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Logging failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !view) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>CRM</h1>
          <p className="subtitle">
            Your CRM stays the system of record. Pull contacts in as leads; approved emails flow
            back as notes.
          </p>
        </div>
      </div>

      {!view.fabric.healthy && (
        <p className="error">
          Connector service offline: {view.fabric.detail ?? "Nango is not reachable."}
        </p>
      )}

      <section className="panel">
        <div className="panel-title-row">
          <h2>Sync</h2>
        </div>
        {crmConnections.length === 0 ? (
          <p className="empty">
            No CRM connected yet.{" "}
            <Link href={`/workspaces/${id}/connectors`}>Connect Freshsales on the connectors page</Link>{" "}
            first.
          </p>
        ) : (
          <div className="resolve-controls">
            <label>
              Connection
              <select
                value={activeConnectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {crmConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {providerLabel(c.providerKey)}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !activeConnectionId} onClick={sync}>
              {busy ? "Working…" : "Sync contacts"}
            </button>
            {syncResult && (
              <span className="meta" style={{ alignSelf: "center" }}>
                {syncResult.fetched} fetched · {syncResult.created} new · {syncResult.updated}{" "}
                updated
                {syncResult.truncated && " — capped at 2,500 contacts; the rest were skipped"}
              </span>
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>CRM contacts ({contacts.length})</h2>
        {contacts.length === 0 ? (
          <p className="empty">Nothing synced yet. Run a sync above.</p>
        ) : (
          <ul className="section-list">
            {contacts.map((contact) => (
              <li key={contact.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {contact.name || "(no name)"}{" "}
                    <span className="meta">&lt;{contact.email || "no email"}&gt;</span>
                    {(contact.role || contact.company) && (
                      <span className="meta">
                        {" "}
                        — {[contact.role, contact.company].filter(Boolean).join(" at ")}
                      </span>
                    )}
                  </span>
                  {contact.lead ? (
                    <span className="layer-badge state-approved">lead: {contact.lead.name}</span>
                  ) : (
                    <button
                      className="button-secondary"
                      disabled={busy || !contact.email}
                      title={contact.email ? "" : "This contact has no email address"}
                      onClick={() => importLead(contact)}
                    >
                      Import as lead
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Leads → CRM</h2>
        {leadsList.length === 0 ? (
          <p className="empty">
            No leads yet. Import a contact above or add leads on the{" "}
            <Link href={`/workspaces/${id}/outbound`}>outbound page</Link>.
          </p>
        ) : (
          <ul className="section-list">
            {leadsList.map((lead) => (
              <li key={lead.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {lead.name} <span className="meta">&lt;{lead.email}&gt;</span>
                  </span>
                  {linkedLeadIds.has(lead.id) ? (
                    <span className="layer-badge state-approved">linked</span>
                  ) : (
                    <button
                      className="button-secondary"
                      disabled={busy || crmConnections.length === 0}
                      onClick={() => pushLead(lead)}
                    >
                      Push to CRM
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Approved outbound drafts → CRM notes</h2>
        {approvedDrafts.length === 0 ? (
          <p className="empty">
            No approved outbound drafts yet. Draft on the{" "}
            <Link href={`/workspaces/${id}/outbound`}>outbound page</Link>, approve in the{" "}
            <Link href={`/workspaces/${id}/approvals`}>queue</Link>, then log them here.
          </p>
        ) : (
          <ul className="section-list">
            {approvedDrafts.map((draft) => {
              const lead = leadsList.find((l) => l.id === draft.leadId);
              const linked = draft.leadId ? linkedLeadIds.has(draft.leadId) : false;
              return (
                <li key={draft.id} className="section-card">
                  <div className="section-head">
                    <span className="section-title">
                      {lead?.name ?? "(lead removed)"}{" "}
                      <span className="meta">{draft.content.slice(0, 80)}…</span>
                    </span>
                    {logged[draft.id] ? (
                      <span className="layer-badge state-approved">
                        logged at {logged[draft.id]}
                      </span>
                    ) : (
                      <button
                        className="button-secondary"
                        disabled={busy || !linked}
                        title={linked ? "" : "Link this lead to a CRM contact first (push or import)"}
                        onClick={() => logDraft(draft)}
                      >
                        Log to CRM
                      </button>
                    )}
                  </div>
                  {!linked && (
                    <p className="section-reason">
                      The lead is not linked to a CRM contact yet — push the lead or import the
                      matching contact first.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
