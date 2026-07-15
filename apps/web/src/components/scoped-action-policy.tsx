"use client";
// Tightening-only persona, connection, and campaign-lane action policy editor.

import { useCallback, useEffect, useState } from "react";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionKind,
  type ExternalActionPolicyScope,
  type ExternalActionPolicyRule,
  type ExternalActionPolicyView,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  actionKindLabel,
  effectivePolicyWorkflowStatus,
  policyConflictCopy,
  policyScopeLabel,
  tighteningPolicyDirty,
  tighteningPolicyDraft,
  type TighteningPolicyDraft,
  type TighteningPolicyRule,
} from "@/lib/external-actions";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Select } from "@/src/components/ui/input";
import styles from "./scoped-action-policy.module.css";

type TighteningScope = Extract<ExternalActionPolicyScope, "persona" | "connection" | "lane">;

interface ScopedActionPolicyProps {
  workspaceId: string;
  scope: TighteningScope;
  scopeId: string;
  title: string;
}

interface ConflictResponse {
  error?: string;
  message?: string;
  current?: ExternalActionPolicyView;
}

function ruleLabel(rule: TighteningPolicyRule): string {
  return rule === "human_required" ? "Human required" : "Inherit";
}

function contributionRuleLabel(rule: ExternalActionPolicyRule): string {
  if (rule === "human_required") return "Human required";
  if (rule === "autonomous") return "Autonomous";
  return "Inherit";
}

export function ScopedActionPolicy({
  workspaceId,
  scope,
  scopeId,
  title,
}: ScopedActionPolicyProps) {
  const [view, setView] = useState<ExternalActionPolicyView | null>(null);
  const [draft, setDraft] = useState<TighteningPolicyDraft | null>(null);
  const [conflict, setConflict] = useState<ExternalActionPolicyView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/workspaces/${workspaceId}/external-action-policies?scope=${scope}&scopeId=${scopeId}`,
      );
      if (!response.ok) throw new Error("policy_load_failed");
      const current = (await response.json()) as ExternalActionPolicyView;
      setView(current);
      setDraft(tighteningPolicyDraft(current));
      setConflict(null);
      setError(null);
    } catch {
      setError("Could not load this action policy.");
    }
  }, [scope, scopeId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!view || !draft || saving || conflict) return;
    setSaving(true);
    setAnnouncement("");
    try {
      const response = await apiFetch(`/workspaces/${workspaceId}/external-action-policies`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          scopeId,
          expectedUpdatedAt: view.updatedAt,
          rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({
            actionKind,
            rule: draft[actionKind],
          })),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ConflictResponse | null;
        if (response.status === 409 && body?.current) {
          setView(body.current);
          setConflict(body.current);
          setAnnouncement(policyConflictCopy());
          return;
        }
        setAnnouncement(body?.message ?? "Could not save this action policy.");
        return;
      }
      const saved = (await response.json()) as ExternalActionPolicyView;
      setView(saved);
      setDraft(tighteningPolicyDraft(saved));
      setConflict(null);
      setAnnouncement(`${title} saved.`);
    } catch {
      setAnnouncement("Could not save this action policy.");
    } finally {
      setSaving(false);
    }
  }

  function reloadConflict() {
    if (!conflict) return;
    setView(conflict);
    setDraft(tighteningPolicyDraft(conflict));
    setConflict(null);
    setAnnouncement("Current policy loaded. Your previous attempted changes were discarded.");
  }

  if (error) {
    return (
      <section className={styles.root}>
        <p className={styles.error}>{error}</p>
        <Button variant="tertiary" size="standard" onClick={() => void load()}>
          Try again
        </Button>
      </section>
    );
  }
  if (!view || !draft) return <p className={styles.loading}>Loading action permission…</p>;

  const conflictDraft = conflict ? tighteningPolicyDraft(conflict) : null;
  const dirty = tighteningPolicyDirty(view, draft);

  return (
    <section className={styles.root} aria-label={title}>
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Action permission</p>
          <h3>{title}</h3>
        </div>
        <p className={styles.scopeNote}>This scope can tighten permission, never loosen it.</p>
      </div>

      <div className={styles.grid}>
        {EXTERNAL_ACTION_KINDS.map((actionKind) => {
          const effective = view.effective.find((item) => item.actionKind === actionKind);
          const contributors = effective?.policy.contributingRules.filter(
            (rule) => rule.rule !== "inherit",
          );
          return (
            <div className={styles.row} key={actionKind}>
              <label className={styles.kind} htmlFor={`${scope}-${scopeId}-${actionKind}`}>
                {actionKindLabel(actionKind)}
              </label>
              <Select
                id={`${scope}-${scopeId}-${actionKind}`}
                value={draft[actionKind]}
                disabled={Boolean(conflict)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    [actionKind]: event.target.value as TighteningPolicyRule,
                  })
                }
              >
                <option value="inherit">Inherit broader policy</option>
                <option value="human_required">Human required</option>
              </Select>
              {effective && (
                <WorkflowStatusBadge
                  status={effectivePolicyWorkflowStatus(effective.policy.effective)}
                />
              )}
              {contributors && contributors.length > 0 && (
                <p className={styles.contributors}>
                  {contributors
                    .map(
                      (rule) =>
                        `${policyScopeLabel(rule.scope)} (${rule.scopeLabel}): ${contributionRuleLabel(
                          rule.rule,
                        )}`,
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {conflict && conflictDraft && (
        <div className={styles.conflict} role="alert">
          <h4>Policy changed in another editor</h4>
          <p>{policyConflictCopy()}</p>
          <div className={styles.conflictRows}>
            {EXTERNAL_ACTION_KINDS.filter(
              (actionKind) => conflictDraft[actionKind] !== draft[actionKind],
            ).map((actionKind) => (
              <div className={styles.conflictRow} key={actionKind}>
                <strong>{actionKindLabel(actionKind)}</strong>
                <span>Current saved setting: {ruleLabel(conflictDraft[actionKind])}</span>
                <span>Your attempted setting: {ruleLabel(draft[actionKind])}</span>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="standard" onClick={reloadConflict}>
            Reload current policy
          </Button>
        </div>
      )}

      <div className={styles.footer}>
        <Button
          variant="primary"
          size="large"
          loading={saving}
          disabled={!dirty || Boolean(conflict)}
          onClick={() => void save()}
        >
          Save action permission
        </Button>
      </div>
      <p className={styles.announcement} aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
