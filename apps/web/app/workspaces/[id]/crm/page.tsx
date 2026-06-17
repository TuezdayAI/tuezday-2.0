"use client";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  Connection,
  ConnectorProvider,
  CrmContact,
  CrmSyncFilter,
  CrmView,
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

/** Epoch ms → YYYY-MM-DD for the date input (and back). */
function msToDate(ms?: number): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

export default function CrmPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [discarded, setDiscarded] = useState<ContactView[]>([]);
  const [leadsList, setLeadsList] = useState<Lead[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [connectionId, setConnectionId] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [logged, setLogged] = useState<Record<string, string>>({});

  // Sync filter, scoped to the active connection.
  const [filterOpen, setFilterOpen] = useState(false);
  const [views, setViews] = useState<CrmView[]>([]);
  const [savedFilter, setSavedFilter] = useState<CrmSyncFilter>({});
  const [filterViewId, setFilterViewId] = useState("");
  const [filterSince, setFilterSince] = useState("");
  const [filterSaved, setFilterSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, ctRes, dcRes, lRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/connectors`),
        apiFetch(`/workspaces/${id}/crm/contacts`),
        apiFetch(`/workspaces/${id}/crm/contacts?discarded=true`),
        apiFetch(`/workspaces/${id}/leads`),
        apiFetch(`/workspaces/${id}/drafts`),
      ]);
      if (!wsRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setView(await cRes.json());
      setContacts(await ctRes.json());
      setDiscarded(await dcRes.json());
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

  // Load the saved filter + available views when the active connection changes.
  useEffect(() => {
    if (!activeConnectionId) {
      setViews([]);
      setSavedFilter({});
      setFilterViewId("");
      setFilterSince("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [fRes, vRes] = await Promise.all([
          apiFetch(`/workspaces/${id}/crm/sync-filter?connectionId=${activeConnectionId}`),
          apiFetch(`/workspaces/${id}/crm/views?connectionId=${activeConnectionId}`),
        ]);
        if (cancelled) return;
        const filter: CrmSyncFilter = fRes.ok ? await fRes.json() : {};
        setSavedFilter(filter);
        setFilterViewId(filter.viewId ?? "");
        setFilterSince(msToDate(filter.updatedSince));
        setViews(vRes.ok ? await vRes.json() : []);
      } catch {
        if (!cancelled) setViews([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, activeConnectionId]);

  const linkedLeadIds = useMemo(
    () => new Set(contacts.filter((c) => c.leadId).map((c) => c.leadId as string)),
    [contacts],
  );
  const approvedDrafts = drafts.filter((d) => d.state === "approved");
  const filterActive = Boolean(savedFilter.viewId || savedFilter.updatedSince);

  function providerLabel(providerKey: string): string {
    return view?.providers.find((p) => p.key === providerKey)?.label ?? providerKey;
  }

  async function post(path: string, payload?: Record<string, unknown>, method = "POST") {
    const res = await apiFetch(`/workspaces/${id}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
    return body;
  }

  async function withBusy(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setSyncResult(null);
    await withBusy(async () => {
      setSyncResult(await post("/crm/sync", { connectionId: activeConnectionId }));
      await load();
    }, "Sync failed");
  }

  async function saveFilter() {
    setFilterSaved(false);
    await withBusy(async () => {
      const chosen = views.find((v) => v.id === filterViewId);
      const filter: CrmSyncFilter = {
        ...(filterViewId ? { viewId: filterViewId, viewName: chosen?.name } : {}),
        ...(filterSince ? { updatedSince: Date.parse(filterSince) } : {}),
      };
      const saved = await post("/crm/sync-filter", { connectionId: activeConnectionId, filter }, "PUT");
      setSavedFilter(saved);
      setFilterSaved(true);
    }, "Could not save filter");
  }

  const importLead = (contact: ContactView) =>
    withBusy(async () => {
      await post(`/crm/contacts/${contact.id}/import-lead`);
      await load();
    }, "Import failed");

  const discardContact = (contact: ContactView) =>
    withBusy(async () => {
      await post(`/crm/contacts/${contact.id}/discard`);
      await load();
    }, "Discard failed");

  const restoreContact = (contact: ContactView) =>
    withBusy(async () => {
      await post(`/crm/contacts/${contact.id}/restore`);
      await load();
    }, "Restore failed");

  const pushLead = (lead: Lead) =>
    withBusy(async () => {
      await post("/crm/push-lead", { leadId: lead.id, connectionId: activeConnectionId });
      await load();
    }, "Push failed");

  async function logDraft(draft: Draft) {
    await withBusy(async () => {
      await post("/crm/log-draft", { draftId: draft.id });
      setLogged((prev) => ({ ...prev, [draft.id]: new Date().toLocaleTimeString() }));
    }, "Logging failed");
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
          <>
            <div className="resolve-controls">
              <label>
                Connection
                <select value={activeConnectionId} onChange={(e) => setConnectionId(e.target.value)}>
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
              <button
                className="button-secondary"
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
              >
                {filterOpen ? "Hide filter" : filterActive ? "Filter: on" : "Filter"}
              </button>
              {syncResult && (
                <span className="meta" style={{ alignSelf: "center" }}>
                  {syncResult.fetched} fetched · {syncResult.created} new · {syncResult.updated}{" "}
                  updated
                  {syncResult.truncated && " — capped at 2,500 contacts; the rest were skipped"}
                </span>
              )}
            </div>

            {filterActive && !filterOpen && (
              <p className="meta">
                Syncing{" "}
                {savedFilter.viewName ?? (savedFilter.viewId ? "a saved view" : "All Contacts")}
                {savedFilter.updatedSince
                  ? `, updated since ${msToDate(savedFilter.updatedSince)}`
                  : ""}
                .
              </p>
            )}

            {filterOpen && (
              <div className="resolve-controls" style={{ marginTop: "0.5rem", flexWrap: "wrap" }}>
                <label>
                  View / list
                  <select value={filterViewId} onChange={(e) => setFilterViewId(e.target.value)}>
                    <option value="">All Contacts (default)</option>
                    {views.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Updated since
                  <input
                    type="date"
                    value={filterSince}
                    onChange={(e) => setFilterSince(e.target.value)}
                  />
                </label>
                <button
                  className="button-secondary"
                  disabled={busy}
                  onClick={saveFilter}
                  style={{ alignSelf: "flex-end" }}
                >
                  Save filter
                </button>
                {(filterViewId || filterSince) && (
                  <button
                    className="button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setFilterViewId("");
                      setFilterSince("");
                    }}
                    style={{ alignSelf: "flex-end" }}
                  >
                    Clear
                  </button>
                )}
                {filterSaved && (
                  <span className="meta" style={{ alignSelf: "center" }}>
                    Saved — applies on the next sync.
                  </span>
                )}
              </div>
            )}
          </>
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
                  <span className="section-actions">
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
                    <button
                      className="button-secondary"
                      disabled={busy}
                      title="Removes it from Tuezday only; a re-sync won't bring it back. Nothing is deleted in your CRM."
                      onClick={() => discardContact(contact)}
                    >
                      Discard
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {discarded.length > 0 && (
        <section className="panel">
          <h2>Discarded ({discarded.length})</h2>
          <p className="section-reason">
            These are hidden locally and a re-sync won't bring them back. Restore one to sync it
            again. Nothing here was deleted in your CRM.
          </p>
          <ul className="section-list">
            {discarded.map((contact) => (
              <li key={contact.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    {contact.name || "(no name)"}{" "}
                    <span className="meta">&lt;{contact.email || "no email"}&gt;</span>
                  </span>
                  <button
                    className="button-secondary"
                    disabled={busy}
                    onClick={() => restoreContact(contact)}
                  >
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
