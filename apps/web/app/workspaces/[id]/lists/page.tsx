"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";
import { TopBarActions } from "@/src/components/top-bar";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./lists.module.css";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AUDIENCE_MEMBER_TYPES,
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  type Audience,
  type AudienceKind,
  type AudienceMember,
  type Campaign,
  type Person,
  type SegmentCombinator,
  type SegmentCondition,
  type SegmentField,
  type SegmentOperator,
  type SegmentRuleGroup,
  type SegmentRuleNode,
  type Workspace,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";

// Operators that take no value.
const VALUELESS: SegmentOperator[] = ["is_set", "is_empty"];

function isGroup(node: SegmentRuleNode): node is SegmentRuleGroup {
  return (node as SegmentRuleGroup).combinator !== undefined;
}

function emptyCondition(): SegmentCondition {
  return { field: "role", operator: "contains", value: "" };
}

function emptyGroup(): SegmentRuleGroup {
  return { combinator: "and", rules: [emptyCondition()] };
}

function label(raw: string): string {
  return raw.replace(/_/g, " ");
}

// --- recursive rule builder -------------------------------------------------

function RuleGroupEditor({
  group,
  onChange,
  onRemove,
  depth = 0,
}: {
  group: SegmentRuleGroup;
  onChange: (next: SegmentRuleGroup) => void;
  onRemove?: () => void;
  depth?: number;
}) {
  function updateRule(index: number, next: SegmentRuleNode) {
    onChange({ ...group, rules: group.rules.map((r, i) => (i === index ? next : r)) });
  }
  function removeRule(index: number) {
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });
  }

  return (
    <div className="rule-group" style={{ border: "1px solid var(--line, #e5ded3)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div className="checkbox-row">
        <span className="meta">Match</span>
        <Select
          value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as SegmentCombinator })}
        >
          <option value="and">ALL of (AND)</option>
          <option value="or">ANY of (OR)</option>
        </Select>
        {onRemove && (
          <Button type="button" variant="tertiary" size="compact" onClick={onRemove}>
            remove group
          </Button>
        )}
      </div>

      {group.rules.map((rule, i) =>
        isGroup(rule) ? (
          <RuleGroupEditor
            key={i}
            group={rule}
            depth={depth + 1}
            onChange={(next) => updateRule(i, next)}
            onRemove={() => removeRule(i)}
          />
        ) : (
          <ConditionEditor
            key={i}
            condition={rule}
            onChange={(next) => updateRule(i, next)}
            onRemove={() => removeRule(i)}
          />
        ),
      )}

      <div className="editor-actions" style={{ marginTop: 8 }}>
        <Button type="button" variant="secondary" size="compact" onClick={() => onChange({ ...group, rules: [...group.rules, emptyCondition()] })}>
          + condition
        </Button>
        {depth < 4 && (
          <Button type="button" variant="secondary" size="compact" onClick={() => onChange({ ...group, rules: [...group.rules, emptyGroup()] })}>
            + nested group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionEditor({
  condition,
  onChange,
  onRemove,
}: {
  condition: SegmentCondition;
  onChange: (next: SegmentCondition) => void;
  onRemove: () => void;
}) {
  const needsValue = !VALUELESS.includes(condition.operator);
  return (
    <div className="checkbox-row" style={{ marginTop: 6 }}>
      <Select value={condition.field} onChange={(e) => onChange({ ...condition, field: e.target.value as SegmentField })}>
        {SEGMENT_FIELDS.map((f) => (
          <option key={f} value={f}>
            {label(f)}
          </option>
        ))}
      </Select>
      <Select value={condition.operator} onChange={(e) => onChange({ ...condition, operator: e.target.value as SegmentOperator })}>
        {SEGMENT_OPERATORS.map((o) => (
          <option key={o} value={o}>
            {label(o)}
          </option>
        ))}
      </Select>
      {needsValue &&
        (condition.field === "type" ? (
          <Select value={condition.value ?? ""} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
            <option value="">—</option>
            {AUDIENCE_MEMBER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={condition.value ?? ""}
            placeholder="value"
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        ))}
      <Button type="button" variant="tertiary" size="compact" onClick={onRemove}>
        remove
      </Button>
    </div>
  );
}

// --- page -------------------------------------------------------------------

interface AudienceDetail {
  audience: Audience;
  members: AudienceMember[];
}

// Sample audiences for the preview-value empty state (spec §6.5) — blurred
// behind the CTA, never shown as real data.
const SAMPLE_AUDIENCES = [
  {
    name: "VPs at fintech",
    kind: "dynamic" as const,
    members: 42,
    description: "role contains “VP” AND company industry contains “fintech”",
  },
  {
    name: "Warm intros — Q3",
    kind: "static" as const,
    members: 12,
    description: "Hand-picked founders we already talked to at SaaStr",
  },
  {
    name: "Replied to launch email",
    kind: "dynamic" as const,
    members: 8,
    description: "type is lead AND notes contains “replied”",
  },
];

const EMPTY_FORM = {
  name: "",
  description: "",
  kind: "static" as AudienceKind,
  rules: emptyGroup(),
};

export default function ListsPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [details, setDetails] = useState<Record<string, AudienceDetail>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, aRes, cRes, pRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/audiences`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/people`),
      ]);
      if (!wsRes.ok || !aRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setAudiences(await aRes.json());
      setCampaigns(cRes.ok ? await cRes.json() : []);
      setPeople(pRes.ok ? await pRes.json() : []);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadDetail(audienceId: string) {
    const res = await apiFetch(`/workspaces/${id}/audiences/${audienceId}`);
    if (!res.ok) return;
    const detail = await res.json();
    setDetails((d) => ({ ...d, [audienceId]: detail }));
  }

  async function toggle(audienceId: string) {
    if (expandedId === audienceId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(audienceId);
    await loadDetail(audienceId);
  }

  function startEdit(a?: Audience) {
    setShowForm(true);
    setEditingId(a?.id ?? null);
    setForm(
      a
        ? {
            name: a.name,
            description: a.description,
            kind: a.kind,
            rules: a.rules ?? emptyGroup(),
          }
        : EMPTY_FORM,
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        kind: form.kind,
        rules: form.kind === "dynamic" ? form.rules : null,
      };
      const url = editingId ? `/workspaces/${id}/audiences/${editingId}` : `/workspaces/${id}/audiences`;
      const res = await apiFetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setShowForm(false);
      setDetails({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: Audience) {
    if (!confirm(`Delete "${a.name}"?`)) return;
    await apiFetch(`/workspaces/${id}/audiences/${a.id}`, { method: "DELETE" });
    await load();
  }

  async function addMembers(audienceId: string, refs: { type: string; id: string }[]) {
    if (refs.length === 0) return;
    await apiFetch(`/workspaces/${id}/audiences/${audienceId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: refs }),
    });
    await Promise.all([loadDetail(audienceId), load()]);
  }

  async function removeMember(audienceId: string, m: AudienceMember) {
    await apiFetch(`/workspaces/${id}/audiences/${audienceId}/members/${m.type}/${m.id}`, {
      method: "DELETE",
    });
    await Promise.all([loadDetail(audienceId), load()]);
  }

  async function attach(audienceId: string, campaignId: string) {
    if (!campaignId) return;
    const res = await apiFetch(`/workspaces/${id}/campaigns/${campaignId}/audiences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audienceId }),
    });
    const name = campaigns.find((c) => c.id === campaignId)?.name ?? "campaign";
    setError(res.ok ? null : "Could not attach to campaign");
    if (res.ok) alert(`Attached to "${name}".`);
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
      <PageHeader title="Lists &amp; segments" subtitle={<>Group leads and contacts into reusable audiences — hand-picked lists or live
            rule-based segments — then attach them to a campaign as its target.</>} />

      <TopBarActions>
        <Button variant="primary" size="compact" onClick={() => startEdit()}>
          <Icon name="add" size="compact" /> New audience
        </Button>
      </TopBarActions>

      {showForm && (
        <Card>
          <CardHeader
            title={
              <span className={styles.cardTitle}>
                <Icon name="audience" size="compact" /> {editingId ? "Edit audience" : "New audience"}
              </span>
            }
          />
          <form className="persona-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }} onSubmit={save}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Audience name (e.g. VPs at fintech)"
              maxLength={200}
            />
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Description (optional)"
              maxLength={1000}
            />
            <div className="checkbox-row">
              <span className="meta">Type:</span>
              <label className="checkbox-label">
                <input
                  type="radio"
                  checked={form.kind === "static"}
                  onChange={() => setForm({ ...form, kind: "static" })}
                />
                Static list (hand-picked)
              </label>
              <label className="checkbox-label">
                <input
                  type="radio"
                  checked={form.kind === "dynamic"}
                  onChange={() => setForm({ ...form, kind: "dynamic" })}
                />
                Dynamic segment (rules)
              </label>
            </div>

            {form.kind === "dynamic" && (
              <div>
                <span className="meta">A person is in this segment when they match:</span>
                <RuleGroupEditor group={form.rules} onChange={(rules) => setForm({ ...form, rules })} />
              </div>
            )}
            {form.kind === "static" && (
              <p className="section-reason">
                Create the list, then add leads &amp; contacts to it from its card below.
              </p>
            )}

            <div className="editor-actions">
              <Button type="submit" variant="primary" disabled={saving || form.name.trim().length === 0}>
                {editingId ? "Update" : "Create"}
              </Button>
              <Button type="button" variant="secondary" size="compact" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </Card>
      )}

      {audiences.length === 0 && !showForm ? (
        <EmptyState
          preview={
            <ul className="section-list">
              {SAMPLE_AUDIENCES.map((a) => (
                <li key={a.name} className="section-card">
                  <div className="section-head">
                    <Badge tone={a.kind === "dynamic" ? "pending" : "approved"}>{a.kind}</Badge>
                    <span className="section-title">{a.name}</span>
                    <span className="section-tokens">{a.members} members</span>
                  </div>
                  <p className="section-reason">{a.description}</p>
                </li>
              ))}
            </ul>
          }
          icon={<Icon name="audience" size="emphasized" />}
          title="Group your audience once, reuse it everywhere"
          description={
            <>
              Build a hand-picked list or a live rule-based segment from your leads and CRM
              contacts, then attach it to a campaign or launch as its target.
            </>
          }
          primaryAction={
            <Button variant="primary" size="compact" onClick={() => startEdit()}>
              <Icon name="add" size="compact" /> New audience
            </Button>
          }
        />
      ) : (
        <ul className="section-list">
          {audiences.map((a) => {
            const detail = details[a.id];
            return (
              <li key={a.id} className="section-card">
                <div className="section-head" onClick={() => toggle(a.id)}>
                  <Badge tone={a.kind === "dynamic" ? "pending" : "approved"}>
                    {a.kind}
                  </Badge>
                  <span className="section-title">{a.name}</span>
                  <span className="section-tokens">
                    <CountBadge count={a.memberCount} label="members" /> members
                  </span>
                </div>
                {a.description && <p className="section-reason">{a.description}</p>}

                {expandedId === a.id && detail && (
                  <div className="campaign-detail">
                    <MemberManager
                      detail={detail}
                      people={people}
                      onAdd={(refs) => addMembers(a.id, refs)}
                      onRemove={(m) => removeMember(a.id, m)}
                    />
                    {campaigns.length > 0 && (
                      <div className="checkbox-row" style={{ marginTop: 10 }}>
                        <span className="meta">Attach to campaign:</span>
                        <Select
                          defaultValue=""
                          onChange={(e) => {
                            void attach(a.id, e.target.value);
                            e.target.value = "";
                          }}
                        >
                          <option value="">Choose a campaign…</option>
                          {campaigns
                            .filter((c) => c.status === "active")
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </Select>
                      </div>
                    )}
                  </div>
                )}

                <div className="rating-row" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="compact" onClick={() => startEdit(a)}>
                    Edit
                  </Button>
                  <Button variant="secondary" size="compact" onClick={() => remove(a)}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function MemberManager({
  detail,
  people,
  onAdd,
  onRemove,
}: {
  detail: AudienceDetail;
  people: Person[];
  onAdd: (refs: { type: string; id: string }[]) => void;
  onRemove: (m: AudienceMember) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const isStatic = detail.audience.kind === "static";
  const memberKeys = new Set(detail.members.map((m) => `${m.type}:${m.id}`));
  const addable = people.filter((p) => !memberKeys.has(`${p.type}:${p.id}`));

  function toggle(key: string) {
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }

  return (
    <>
      <p className="bundle-summary">
        {detail.members.length} member{detail.members.length === 1 ? "" : "s"}
        {isStatic ? "" : " (computed live from the rules)"}
      </p>
      {detail.members.length > 0 && (
        <ul className="draft-chain">
          {detail.members.map((m) => (
            <li key={`${m.type}:${m.id}`}>
              <span className={`layer-badge ${m.type === "lead" ? "state-approved" : "state-edited"}`}>{m.type}</span>{" "}
              <span className="meta">
                {m.name}
                {m.role ? ` · ${m.role}` : ""}
                {m.company ? ` · ${m.company}` : ""}
              </span>{" "}
              {isStatic && (
                <Button type="button" variant="tertiary" size="compact" onClick={() => onRemove(m)}>
                  remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isStatic && (
        <div style={{ marginTop: 8 }}>
          {addable.length === 0 ? (
            <p className="section-reason">Every lead &amp; contact is already in this list.</p>
          ) : (
            <>
              <span className="meta">Add leads &amp; contacts:</span>
              <ul className="draft-chain" style={{ maxHeight: 180, overflowY: "auto" }}>
                {addable.map((p) => {
                  const key = `${p.type}:${p.id}`;
                  return (
                    <li key={key}>
                      <label className="checkbox-label">
                        <input type="checkbox" checked={picked.includes(key)} onChange={() => toggle(key)} />
                        <span className={`layer-badge ${p.type === "lead" ? "state-approved" : "state-edited"}`}>
                          {p.type}
                        </span>{" "}
                        {p.name}
                        {p.role ? ` · ${p.role}` : ""}
                        {p.company ? ` · ${p.company}` : ""}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                disabled={picked.length === 0}
                onClick={() => {
                  onAdd(picked.map((k) => ({ type: k.split(":")[0]!, id: k.split(":")[1]! })));
                  setPicked([]);
                }}
              >
                Add {picked.length > 0 ? `(${picked.length})` : ""}
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
