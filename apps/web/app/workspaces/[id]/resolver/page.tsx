"use client";

import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CHANNELS,
  DEFAULT_TOKEN_BUDGET,
  SOCIAL_ACCOUNT_CHANNELS,
  TASK_TYPES,
  type Campaign,
  type Channel,
  type Connection,
  type ConnectorProvider,
  type Persona,
  type PersonaSocialAccount,
  type SocialAccountChannel,
  type TaskType,
  type Workspace,
} from "@tuezday/contracts";
import type { ContextSection, ResolvedContext } from "@tuezday/brain";
import {
  connectionLabel,
  defaultTargetForChannel,
  providerForPersonaSocialChannel,
} from "@/lib/persona-social-routing";

const TASK_LABELS: Record<TaskType, string> = {
  linkedin_post: "LinkedIn post",
  cold_email_opener: "Cold email opener",
  ad_copy_variant: "Ad copy variant",
  landing_page_hero: "Landing page hero",
  signal_response: "Signal response",
  outbound_email: "Outbound email",
  meta_ad_creative: "Meta ad creative",
  google_rsa: "Google RSA",
  pr_pitch: "Media pitch",
  press_boilerplate: "Press boilerplate",
  x_dm: "X DM",
  instagram_post: "Instagram post",
  engagement_reply: "Reply",
};

interface ConnectorsView {
  providers: ConnectorProvider[];
  connections: Connection[];
}

interface AssignmentDraft {
  channel: SocialAccountChannel;
  connectionId: string;
  isPrimary: boolean;
}

const defaultAssignmentDraft = (): AssignmentDraft => ({
  channel: "linkedin",
  connectionId: "",
  isPrimary: true,
});

export default function ResolverPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [socialAccounts, setSocialAccounts] = useState<Connection[]>([]);
  const [assignmentsByPersona, setAssignmentsByPersona] = useState<
    Record<string, PersonaSocialAccount[]>
  >({});
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [assignmentBusy, setAssignmentBusy] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // resolve controls
  const [taskType, setTaskType] = useState<TaskType>("linkedin_post");
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [personaId, setPersonaId] = useState<string>("");
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [useEvidence, setUseEvidence] = useState(true);
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [bundle, setBundle] = useState<ResolvedContext | null>(null);
  const [resolving, setResolving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // persona form
  const [showPersonaForm, setShowPersonaForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pDescription, setPDescription] = useState("");
  const [pOverlay, setPOverlay] = useState("");

  const load = useCallback(async () => {
    try {
      const [wsRes, pRes, cRes, conRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/connectors`),
      ]);
      if (!wsRes.ok || !pRes.ok || !cRes.ok) throw new Error("not found");
      const personaRows = (await pRes.json()) as Persona[];
      setWorkspace(await wsRes.json());
      setPersonas(personaRows);
      setCampaigns(((await cRes.json()) as Campaign[]).filter((c) => c.status === "active"));

      if (conRes.ok) {
        const view = (await conRes.json()) as ConnectorsView;
        const socialProviderKeys = new Set(
          view.providers.filter((p) => p.categories?.includes("social")).map((p) => p.key),
        );
        setSocialAccounts(
          view.connections.filter(
            (connection) =>
              connection.status === "connected" && socialProviderKeys.has(connection.providerKey),
          ),
        );
      } else {
        setSocialAccounts([]);
      }

      const assignmentEntries = await Promise.all(
        personaRows.map(async (persona) => {
          const res = await apiFetch(`/workspaces/${id}/personas/${persona.id}/social-accounts`);
          return [
            persona.id,
            res.ok ? ((await res.json()) as PersonaSocialAccount[]) : [],
          ] as const;
        }),
      );
      setAssignmentsByPersona(Object.fromEntries(assignmentEntries));
      setAssignmentDrafts((current) => {
        const next: Record<string, AssignmentDraft> = {};
        for (const persona of personaRows) next[persona.id] = current[persona.id] ?? defaultAssignmentDraft();
        return next;
      });
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve() {
    setResolving(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType,
          channel,
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
          tokenBudget,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setBundle(await res.json());
      setExpanded({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setResolving(false);
    }
  }

  function startEdit(p?: Persona) {
    setShowPersonaForm(true);
    setEditingId(p?.id ?? null);
    setPName(p?.name ?? "");
    setPDescription(p?.description ?? "");
    setPOverlay(p?.overlay ?? "");
  }

  async function savePersona(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const url = editingId
        ? `/workspaces/${id}/personas/${editingId}`
        : `/workspaces/${id}/personas`;
      const res = await apiFetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pName, description: pDescription, overlay: pOverlay }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setShowPersonaForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save persona");
    }
  }

  async function removePersona(persona: Persona) {
    if (!confirm(`Delete persona "${persona.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/personas/${persona.id}`, { method: "DELETE" });
    if (personaId === persona.id) setPersonaId("");
    await load();
  }

  function draftFor(personaId: string): AssignmentDraft {
    return assignmentDrafts[personaId] ?? defaultAssignmentDraft();
  }

  function updateAssignmentDraft(personaId: string, patch: Partial<AssignmentDraft>) {
    setAssignmentDrafts((current) => {
      const previous = current[personaId] ?? defaultAssignmentDraft();
      const channelChanged = patch.channel && patch.channel !== previous.channel;
      return {
        ...current,
        [personaId]: {
          ...previous,
          ...patch,
          connectionId: channelChanged ? "" : (patch.connectionId ?? previous.connectionId),
        },
      };
    });
  }

  function accountOptionsForChannel(channel: SocialAccountChannel): Connection[] {
    const providerKey = providerForPersonaSocialChannel(channel);
    return socialAccounts.filter((account) => account.providerKey === providerKey);
  }

  function accountById(connectionId: string): Connection | undefined {
    return socialAccounts.find((account) => account.id === connectionId);
  }

  async function assignAccount(personaId: string) {
    const draft = draftFor(personaId);
    if (!draft.connectionId) return;
    setAssignmentBusy(personaId);
    setAssignmentError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/personas/${personaId}/social-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: draft.connectionId,
          channel: draft.channel,
          isPrimary: draft.isPrimary,
          defaultTarget: defaultTargetForChannel(draft.channel),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      updateAssignmentDraft(personaId, { connectionId: "" });
      await load();
    } catch (err) {
      setAssignmentError(err instanceof Error ? err.message : "Failed to assign account");
    } finally {
      setAssignmentBusy(null);
    }
  }

  async function makePrimary(personaId: string, assignment: PersonaSocialAccount) {
    setAssignmentBusy(personaId);
    setAssignmentError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/personas/${personaId}/social-accounts/${assignment.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: assignment.connectionId,
            channel: assignment.channel,
            isPrimary: true,
            defaultTarget: assignment.defaultTarget || defaultTargetForChannel(assignment.channel),
          }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setAssignmentError(err instanceof Error ? err.message : "Failed to update assignment");
    } finally {
      setAssignmentBusy(null);
    }
  }

  async function removeAssignment(personaId: string, assignmentId: string) {
    setAssignmentBusy(personaId);
    setAssignmentError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/personas/${personaId}/social-accounts/${assignmentId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await load();
    } catch (err) {
      setAssignmentError(err instanceof Error ? err.message : "Failed to remove assignment");
    } finally {
      setAssignmentBusy(null);
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

  if (!workspace) return <EmptyState description="Loading…" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Context inspector</h1>
          <p className="subtitle">
            See the exact context Tuezday would assemble for any task — before any AI sees it.
            Personas live here too.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Personas</h2>
          <button className="button-secondary" onClick={() => startEdit()}>
            + New persona
          </button>
        </div>
        {personas.length === 0 ? (
          <EmptyState description={<>No personas yet. Create one (e.g. “CEO voice”, “Company page”) to see the same brain
            resolve differently.</>} />
        ) : (
          <ul className="persona-list">
            {personas.map((p) => (
              <li key={p.id} className="persona-card">
                <div>
                  <span className="name">{p.name}</span>
                  {p.description && <span className="meta"> — {p.description}</span>}
                </div>
                <div className="persona-actions">
                  <button className="button-secondary" onClick={() => startEdit(p)}>
                    Edit
                  </button>
                  <button className="button-secondary danger" onClick={() => removePersona(p)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {showPersonaForm && (
          <form className="persona-form" onSubmit={savePersona}>
            <input
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              placeholder="Persona name (e.g. CEO)"
              maxLength={100}
            />
            <input
              value={pDescription}
              onChange={(e) => setPDescription(e.target.value)}
              placeholder="Who is speaking? (e.g. Founder, first person)"
              maxLength={500}
            />
            <textarea
              value={pOverlay}
              onChange={(e) => setPOverlay(e.target.value)}
              placeholder="Overlay — voice and point-of-view adjustments layered on the org brain…"
              rows={5}
            />
            <div className="editor-actions">
              <button type="submit" disabled={pName.trim().length === 0}>
                {editingId ? "Update persona" : "Create persona"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setShowPersonaForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {personas.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 16 }}>
            <h2>Social account routing</h2>
            <p className="subtitle">
              Assign connected social accounts to personas and mark the default account per channel.
            </p>
            {assignmentError && <p className="error">{assignmentError}</p>}
            {socialAccounts.length === 0 ? (
              <EmptyState
                description={
                  <>
                    No connected social accounts yet.{" "}
                    <Link href={`/workspaces/${id}/connectors`}>Connect one</Link> first.
                  </>
                }
              />
            ) : (
              <ul className="section-list">
                {personas.map((persona) => {
                  const draft = draftFor(persona.id);
                  const assignments = assignmentsByPersona[persona.id] ?? [];
                  const accountOptions = accountOptionsForChannel(draft.channel);
                  return (
                    <li key={persona.id} className="section-card">
                      <div className="section-head">
                        <span className="layer-badge layer-persona">persona</span>
                        <span className="section-title">{persona.name}</span>
                      </div>

                      {assignments.length === 0 ? (
                        <p className="section-reason">No social accounts assigned yet.</p>
                      ) : (
                        <ul className="draft-chain">
                          {assignments.map((assignment) => {
                            const account = accountById(assignment.connectionId);
                            return (
                              <li key={assignment.id}>
                                <span className="layer-badge layer-channel">{assignment.channel}</span>{" "}
                                <span className="meta">
                                  {account
                                    ? connectionLabel(account)
                                    : `${assignment.providerKey} account`}
                                </span>{" "}
                                {assignment.isPrimary && (
                                  <span className="layer-badge state-approved">primary</span>
                                )}{" "}
                                {!assignment.isPrimary && (
                                  <button
                                    type="button"
                                    className="link-button"
                                    disabled={assignmentBusy === persona.id}
                                    onClick={() => void makePrimary(persona.id, assignment)}
                                  >
                                    make primary
                                  </button>
                                )}{" "}
                                <button
                                  type="button"
                                  className="link-button"
                                  disabled={assignmentBusy === persona.id}
                                  onClick={() => void removeAssignment(persona.id, assignment.id)}
                                >
                                  remove
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      <div className="resolve-controls" style={{ marginTop: 10 }}>
                        <label>
                          Channel
                          <select
                            value={draft.channel}
                            onChange={(e) =>
                              updateAssignmentDraft(persona.id, {
                                channel: e.target.value as SocialAccountChannel,
                              })
                            }
                          >
                            {SOCIAL_ACCOUNT_CHANNELS.map((socialChannel) => (
                              <option key={socialChannel} value={socialChannel}>
                                {socialChannel}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Account
                          <select
                            value={draft.connectionId}
                            onChange={(e) =>
                              updateAssignmentDraft(persona.id, { connectionId: e.target.value })
                            }
                          >
                            <option value="">pick an account</option>
                            {accountOptions.map((account) => (
                              <option key={account.id} value={account.id}>
                                {connectionLabel(account)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="checkbox-label" style={{ alignSelf: "center" }}>
                          <input
                            type="checkbox"
                            checked={draft.isPrimary}
                            onChange={(e) =>
                              updateAssignmentDraft(persona.id, { isPrimary: e.target.checked })
                            }
                          />
                          Primary
                        </label>
                        <button
                          type="button"
                          disabled={!draft.connectionId || assignmentBusy === persona.id}
                          onClick={() => void assignAccount(persona.id)}
                        >
                          Assign account
                        </button>
                      </div>
                      {accountOptions.length === 0 && (
                        <p className="section-reason">
                          Connect a {draft.channel} account before assigning this channel.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Resolve</h2>
        <div className="resolve-controls">
          <label>
            Task
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
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
          <label>
            Token budget
            <input
              type="number"
              min={500}
              max={200000}
              value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
            />
          </label>
          <label className="checkbox-label" style={{ alignSelf: "center" }}>
            <input
              type="checkbox"
              checked={useEvidence}
              onChange={(e) => setUseEvidence(e.target.checked)}
            />
            Use evidence
          </label>
          <button onClick={resolve} disabled={resolving}>
            {resolving ? "Resolving…" : "Resolve context"}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {bundle && (
          <div className="bundle">
            <p className="bundle-summary">
              {bundle.sections.filter((s) => s.included).length} of {bundle.sections.length}{" "}
              sections included · ~{bundle.includedTokens} tokens of {bundle.tokenBudget} budget
              {bundle.overBudget && (
                <span className="error"> — over budget: trim your docs or raise the budget</span>
              )}
            </p>
            <ol className="section-list">
              {bundle.sections.map((s: ContextSection) => (
                <li key={s.key} className={`section-card ${s.included ? "" : "excluded"}`}>
                  <div
                    className="section-head"
                    onClick={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))}
                  >
                    <span className={`layer-badge layer-${s.layer}`}>{s.layer}</span>
                    <span className="section-title">{s.title}</span>
                    <span className="section-tokens">
                      {s.included ? `~${s.tokens} tok` : "excluded"}
                    </span>
                  </div>
                  <p className="section-reason">{s.reason}</p>
                  {expanded[s.key] && s.content && (
                    <pre className="section-content">{s.content}</pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </>
  );
}
