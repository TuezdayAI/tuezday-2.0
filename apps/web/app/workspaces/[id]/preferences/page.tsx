"use client";

import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./preferences.module.css";

import { API_URL, apiFetch } from "@/lib/api";
import {
  actionLabel,
  availableActions,
  editSummary,
  groupByStatus,
  memoryState,
  provenanceLine,
  scopeLabel,
  statusHelp,
  statusLabel,
  statusTone,
} from "@/lib/preferences-view";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CHANNELS } from "@tuezday/contracts";
import type {
  Channel,
  PreferenceEdit,
  PreferenceRule,
  PreferenceRuleDetail,
  PreferenceRuleStatus,
  Workspace,
} from "@tuezday/contracts";

export default function PreferencesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [rules, setRules] = useState<PreferenceRule[] | null>(null);
  const [edits, setEdits] = useState<PreferenceEdit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newRule, setNewRule] = useState("");
  const [newChannel, setNewChannel] = useState<Channel | "">("");
  const [openRule, setOpenRule] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, PreferenceRuleDetail>>({});

  const load = useCallback(async () => {
    try {
      const [wsRes, ruleRes, editRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/preferences/rules`),
        apiFetch(`/workspaces/${id}/preferences/edits`),
      ]);
      if (!wsRes.ok || !ruleRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      setRules((await ruleRes.json()).rules);
      if (editRes.ok) setEdits((await editRes.json()).edits);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addRule() {
    if (!newRule.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/preferences/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rule: newRule.trim(),
          polarity: "avoid",
          ...(newChannel ? { scopeChannel: newChannel } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setNewRule("");
      setNote("Rule added. It applies to the next matching draft.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the rule");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(ruleId: string, status: PreferenceRuleStatus) {
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/preferences/rules/${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the rule");
    }
  }

  async function removeRule(ruleId: string) {
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/preferences/rules/${ruleId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the rule");
    }
  }

  async function extractNow() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/preferences/extract`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setNote(
        body.edits === 0
          ? "No new edits to read — everything captured so far has already been digested."
          : `Read ${body.edits} edit(s): ${body.created} new rule(s), ${body.merged} reinforced, ${body.retired} retired.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(ruleId: string) {
    if (openRule[ruleId]) {
      setOpenRule((prev) => ({ ...prev, [ruleId]: false }));
      return;
    }
    setOpenRule((prev) => ({ ...prev, [ruleId]: true }));
    if (details[ruleId]) return;
    try {
      const res = await apiFetch(`/workspaces/${id}/preferences/rules/${ruleId}`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const detail = (await res.json()) as PreferenceRuleDetail;
      setDetails((prev) => ({ ...prev, [ruleId]: detail }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the rule's evidence");
      setOpenRule((prev) => ({ ...prev, [ruleId]: false }));
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

  if (!workspace || !rules) return <EmptyState description="Loading…" />;

  const groups = groupByStatus(rules);
  const state = memoryState(rules, edits);

  return (
    <>
      <p className="subtitle">
        Every time you edit a draft, the correction is captured. A rule extracted from those edits
        applies to the next matching draft the same day — not next week. Each rule shows the edits
        it was learned from, and you can switch any of them off. Rules that prove stable are folded
        into your brain docs by a weekly synthesis you still accept by hand.
      </p>

      {error && <p className="error">{error}</p>}
      {note && <p className={styles.note}>{note}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-learning" size="compact" className={styles.headIcon} />
              Learned rules
            </span>
          }
          actions={
            <Button variant="secondary" size="compact" onClick={extractNow} disabled={busy}>
              Read my latest edits
            </Button>
          }
        />

        {state === "empty" && (
          <EmptyState description="Nothing captured yet. Edit a draft at the approval gate and the correction lands here." />
        )}
        {state === "pending" && (
          <EmptyState
            description={`${edits.length} correction(s) captured, nothing extracted yet. The worker reads them on its next pass, or use "Read my latest edits".`}
          />
        )}

        {groups.map((group) => (
          <section key={group.status} className={styles.group}>
            <div className={styles.groupHead}>
              <Badge tone={statusTone(group.status)}>{statusLabel(group.status)}</Badge>
              <span className={styles.groupHelp}>{statusHelp(group.status)}</span>
            </div>
            <ul className={styles.itemList}>
              {group.rules.map((rule) => (
                <li key={rule.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <p className={styles.rule}>
                      {rule.polarity === "avoid" ? "Avoid: " : "Do: "}
                      {rule.rule}
                    </p>
                    <div className={styles.actions}>
                      {availableActions(rule.status).map((next) => (
                        <Button
                          key={next}
                          variant="secondary"
                          size="compact"
                          onClick={() => changeStatus(rule.id, next)}
                        >
                          {actionLabel(next)}
                        </Button>
                      ))}
                      <Button
                        variant="tertiary"
                        size="compact"
                        onClick={() => toggleRule(rule.id)}
                      >
                        {openRule[rule.id] ? "Hide evidence" : "Why?"}
                      </Button>
                      <Button
                        variant="tertiary"
                        size="compact"
                        onClick={() => removeRule(rule.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  <div className={styles.meta}>
                    <span>{scopeLabel(rule)}</span>
                    <span>·</span>
                    <span>{provenanceLine(rule)}</span>
                    <span>·</span>
                    <span>confidence {rule.confidence}</span>
                  </div>
                  {openRule[rule.id] && (
                    <div className={styles.evidence}>
                      {(details[rule.id]?.evidence ?? []).length === 0 && (
                        <p className={styles.excerpt}>
                          No stored evidence — this rule was written by hand.
                        </p>
                      )}
                      {(details[rule.id]?.evidence ?? []).map((item) => (
                        <div key={item.id}>
                          <p className={styles.excerpt}>{item.excerpt}</p>
                          {item.edit?.draftId && (
                            <Link href={`/workspaces/${id}/approvals`} className={styles.groupHelp}>
                              the draft this came from →
                            </Link>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="edit" size="compact" className={styles.headIcon} />
              Write a rule yourself
            </span>
          }
        />
        <p className={styles.note}>
          You do not have to wait to be learned from. A rule you write is active immediately and
          ranks alongside the extracted ones.
        </p>
        <div className={styles.row}>
          <label className={styles.field}>
            Rule
            <Input
              value={newRule}
              onChange={(event) => setNewRule(event.target.value)}
              placeholder="Never open with a rhetorical question"
              maxLength={160}
            />
          </label>
          <label className={styles.field}>
            Channel
            <Select
              value={newChannel}
              onChange={(event) => setNewChannel(event.target.value as Channel | "")}
            >
              <option value="">every channel</option>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </Select>
          </label>
          <Button onClick={addRule} disabled={busy || newRule.trim().length < 8}>
            Add rule
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="review" size="compact" className={styles.headIcon} />
              Captured corrections
            </span>
          }
        />
        <p className={styles.note}>
          Every edit you make at the gate or in the editor, exactly as captured. Undigested ones are
          waiting for the next extraction pass.
        </p>
        {edits.length === 0 ? (
          <EmptyState description="No corrections captured yet." />
        ) : (
          <ul className={styles.editList}>
            {edits.slice(0, 20).map((edit) => (
              <li key={edit.id} className={styles.edit}>
                <Badge tone={edit.digestedAt ? "approved" : "neutral"}>
                  {edit.digestedAt ? "read" : "pending"}
                </Badge>
                <span>{editSummary(edit)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
