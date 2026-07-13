"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { PreviewCard } from "@/src/components/ui/preview-card";
import { Input, Textarea, Select } from "@/src/components/ui/input";
import styles from "./pr.module.css";


import { API_URL, apiDownload, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  MEDIA_CONTACT_TYPES,
  PR_PITCH_TYPES,
  type ApprovalState,
  type Campaign,
  type Draft,
  type MediaContact,
  type MediaContactType,
  type Persona,
  type PrPitchType,
  type Signal,
  type Workspace,
} from "@tuezday/contracts";

const STATE_LABELS: Record<ApprovalState, string> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

const STATE_BADGE_TONES: Record<
  ApprovalState,
  "draft" | "pending" | "edited" | "approved" | "rejected"
> = {
  draft: "draft",
  pending_review: "pending",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
};

const CONTACT_TYPE_LABELS: Record<MediaContactType, string> = {
  journalist: "Journalist",
  publication: "Publication",
  podcast: "Podcast",
};

const PITCH_TYPE_LABELS: Record<PrPitchType, string> = {
  announcement: "Announcement",
  thought_leadership: "Thought leadership",
  reactive: "Reactive (responds to a signal)",
};

const CSV_EXAMPLE = `name,email,outlet,beat,type,notes
Riya Sen,riya@techcrunch.com,TechCrunch India,"AI startups, developer tools",journalist,Covered GTM tooling in May`;

/** Split an approved pitch into mailto subject + body. */
function mailtoHref(email: string, content: string): string {
  const match = /^Subject:\s*(.+)\r?\n\r?\n?([\s\S]*)$/.exec(content.trim());
  const subject = match ? match[1]!.trim() : "";
  const body = match ? match[2]!.trim() : content.trim();
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Subject/body split for the email PreviewCard renderer (pitches lead with a subject line). */
function splitPitch(content: string): { title: string; body: string } {
  const lines = content.split("\n");
  const first = (lines[0] ?? "").replace(/^Subject:\s*/i, "").trim();
  if (!first) return { title: "Media pitch", body: content };
  return { title: first, body: lines.slice(1).join("\n").trim() };
}

// Sample media contacts for the preview-value empty state (spec §6.5) —
// blurred behind the CTA, never shown as real data.
const SAMPLE_MEDIA_CONTACTS = [
  {
    name: "Riya Sen",
    email: "riya@techcrunch.com",
    detail: "Journalist at TechCrunch India · AI startups, developer tools",
    state: "approved" as const,
    snippet: "Subject: The GTM stack founders actually keep — your May teardown…",
  },
  {
    name: "Tom Alder",
    email: "tom@strategybreakdowns.com",
    detail: "Publication at Strategy Breakdowns · GTM, positioning",
    state: "pending" as const,
    snippet: "Subject: A counter-take on AI slop for your next issue…",
  },
  {
    name: "Lenny's Podcast",
    email: "pitches@lennyspodcast.com",
    detail: "Podcast · product, growth",
    state: "draft" as const,
    snippet: "Subject: Founder story — rebuilding GTM around one editable brain…",
  },
];

const EMPTY_CONTACT = {
  name: "",
  email: "",
  type: "journalist" as MediaContactType,
  outlet: "",
  beat: "",
  coverageNotes: "",
};

export default function PrPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [contacts, setContacts] = useState<MediaContact[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [csv, setCsv] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContact, setNewContact] = useState(EMPTY_CONTACT);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pitchType, setPitchType] = useState<PrPitchType>("announcement");
  const [signalId, setSignalId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [useEvidence, setUseEvidence] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kitBusy, setKitBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, cRes, pRes, campRes, sRes, dRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/media-contacts`),
        apiFetch(`/workspaces/${id}/personas`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/signals`),
        apiFetch(`/workspaces/${id}/drafts`),
      ]);
      if (!wsRes.ok || !cRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setContacts(await cRes.json());
      setPersonas(await pRes.json());
      setCampaigns(((await campRes.json()) as Campaign[]).filter((c) => c.status === "active"));
      setSignals(await sRes.json());
      setDrafts(
        ((await dRes.json()) as Draft[]).filter(
          (d) => d.mediaContactId || d.taskType === "press_boilerplate",
        ),
      );
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
      const res = await apiFetch(`/workspaces/${id}/media-contacts/import`, {
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

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/media-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newContact),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setNewContact(EMPTY_CONTACT);
      setShowAddForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contact");
    } finally {
      setBusy(false);
    }
  }

  async function removeContact(contact: MediaContact) {
    if (!confirm(`Delete contact "${contact.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/media-contacts/${contact.id}`, { method: "DELETE" });
    await load();
  }

  async function draftPitches() {
    const contactIds = Object.keys(selected).filter((k) => selected[k]);
    setDrafting(true);
    setError(null);
    setDraftSummary(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pr/pitch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactIds,
          pitchType,
          signalId: pitchType === "reactive" ? signalId || undefined : undefined,
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
        `${ok} pitch(es) sent to Review${failed ? `, ${failed} failed (retry those contacts)` : ""}.`,
      );
      setSelected({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drafting failed");
    } finally {
      setDrafting(false);
    }
  }

  async function generatePressKit() {
    setKitBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/pr/press-kit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId: personaId || undefined,
          campaignId: campaignId || undefined,
          useEvidence,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Press kit generation failed");
    } finally {
      setKitBusy(false);
    }
  }

  const contactById = new Map(contacts.map((c) => [c.id, c]));

  function pitchesForContact(contactId: string): Draft[] {
    return drafts.filter((d) => d.mediaContactId === contactId);
  }

  const pressKitDrafts = drafts.filter((d) => d.taskType === "press_boilerplate");
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const approvedPitches = drafts.filter((d) => d.mediaContactId && d.state === "approved");

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
      <PageHeader title="PR &amp; media" subtitle={<>Your media list, with pitches drafted in your voice per contact — referencing their
            actual beat, never inventing coverage. Pitches go through Review; sending stays in your
            email client.</>} actions={<>
            {approvedPitches.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void apiDownload(`/workspaces/${id}/pr/export.csv`, "pr-pitches.csv")}
            >
              ↓ Export approved CSV ({approvedPitches.length})
            </Button>
          )}
          </>} />

      <Card>
        <CardHeader
          title={`Media contacts (${contacts.length})`}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setShowAddForm(!showAddForm)}>
              + Add one contact
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
            placeholder={`Paste a CSV of media contacts…\n\n${CSV_EXAMPLE}`}
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
          <form className="persona-form" onSubmit={addContact}>
            <div className="resolve-controls">
              <label style={{ flex: 1 }}>
                Name
                <Input
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                />
              </label>
              <label style={{ flex: 1 }}>
                Email
                <Input
                  value={newContact.email}
                  onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                />
              </label>
              <label>
                Type
                <Select
                  value={newContact.type}
                  onChange={(e) =>
                    setNewContact({ ...newContact, type: e.target.value as MediaContactType })
                  }
                >
                  {MEDIA_CONTACT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CONTACT_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Outlet
                <Input
                  value={newContact.outlet}
                  onChange={(e) => setNewContact({ ...newContact, outlet: e.target.value })}
                />
              </label>
              <label>
                Beat
                <Input
                  value={newContact.beat}
                  onChange={(e) => setNewContact({ ...newContact, beat: e.target.value })}
                />
              </label>
            </div>
            <Input
              value={newContact.coverageNotes}
              onChange={(e) => setNewContact({ ...newContact, coverageNotes: e.target.value })}
              placeholder="Past coverage notes — what have they actually written about?"
            />
            <div className="editor-actions">
              <Button type="submit" variant="primary" disabled={busy}>
                Add contact
              </Button>
            </div>
          </form>
        )}
        {error && <p className="error">{error}</p>}

        {contacts.length === 0 ? (
          <EmptyState description={<>No media contacts yet. Paste a CSV above.</>} />
        ) : (
          <ul className="section-list">
            {contacts.map((contact) => {
              const chain = pitchesForContact(contact.id);
              return (
                <li key={contact.id} className="section-card">
                  <div className="section-head">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={!!selected[contact.id]}
                        onChange={(e) =>
                          setSelected({ ...selected, [contact.id]: e.target.checked })
                        }
                      />
                    </label>
                    <span className="section-title">
                      {contact.name} <span className="meta">&lt;{contact.email}&gt;</span>
                      <span className="meta">
                        {" "}
                        — {CONTACT_TYPE_LABELS[contact.type]}
                        {contact.outlet && ` at ${contact.outlet}`}
                        {contact.beat && ` · ${contact.beat}`}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => removeContact(contact)}>
                      delete
                    </Button>
                  </div>
                  {contact.coverageNotes && (
                    <p className="section-reason">{contact.coverageNotes}</p>
                  )}
                  {chain.length > 0 && (
                    <ul className="draft-chain">
                      {chain.map((d) => (
                        <li key={d.id}>
                          <Badge tone={STATE_BADGE_TONES[d.state]}>
                            {STATE_LABELS[d.state]}
                          </Badge>{" "}
                          <span className="meta">{d.content.slice(0, 70)}…</span>{" "}
                          {d.state === "approved" && (
                            <a className="link-button" href={mailtoHref(contact.email, d.content)}>
                              open in email client
                            </a>
                          )}{" "}
                          <Link className="link-button" href={`/workspaces/${id}/review`}>
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
      </Card>

      <Card>
        <h2>Draft media pitches</h2>
        <div className="resolve-controls">
          <label>
            Pitch type
            <Select
              value={pitchType}
              onChange={(e) => setPitchType(e.target.value as PrPitchType)}
            >
              {PR_PITCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PITCH_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </label>
          {pitchType === "reactive" && (
            <label>
              Signal
              <Select value={signalId} onChange={(e) => setSignalId(e.target.value)}>
                <option value="">(pick a signal)</option>
                {signals.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.source}] {s.content.slice(0, 60)}
                  </option>
                ))}
              </Select>
            </label>
          )}
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
          <Button
            variant="primary"
            disabled={drafting || selectedCount === 0 || (pitchType === "reactive" && !signalId)}
            onClick={draftPitches}
          >
            {drafting
              ? "Drafting…"
              : `Draft ${selectedCount || ""} pitch${selectedCount === 1 ? "" : "es"}`}
          </Button>
        </div>
        {pitchType === "reactive" && signals.length === 0 && (
          <p className="meta">
            No signals yet — accept one from the{" "}
            <Link href={`/workspaces/${id}/discovery`}>Discover inbox</Link> or add one manually
            first.
          </p>
        )}
        {draftSummary && <p className="bundle-summary">{draftSummary}</p>}
      </Card>

      <Card>
        <CardHeader
          title="Press kit"
          actions={
            <Button variant="secondary" size="sm" disabled={kitBusy} onClick={generatePressKit}>
              {kitBusy ? "Generating…" : "Generate from brain"}
            </Button>
          }
        />
        <p className="meta">
          One-liner, about paragraph, and key facts from your brain docs. Each generation is a new
          version; edit and approve it in Review like any other output.
        </p>
        {pressKitDrafts.length === 0 ? (
          <EmptyState description={<>No press kit yet. Generate one from your brain docs.</>} />
        ) : (
          <ul className="section-list">
            {pressKitDrafts.map((d, i) => (
              <li key={d.id} className="section-card">
                <div className="section-head">
                  <span className="section-title">
                    Version {pressKitDrafts.length - i}{" "}
                    <Badge tone={STATE_BADGE_TONES[d.state]}>{STATE_LABELS[d.state]}</Badge>
                  </span>
                  <span className="meta">{new Date(d.createdAt).toLocaleString()}</span>
                  <Link className="link-button" href={`/workspaces/${id}/review`}>
                    open in queue
                  </Link>
                </div>
                <pre className="output-text">{d.content}</pre>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
