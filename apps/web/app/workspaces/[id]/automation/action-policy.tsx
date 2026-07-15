"use client";
// Workspace action-permission defaults. The guardrails above tune automation
// cadence — how often campaigns draft and post. This control is about
// permission: whether each kind of external action may leave the workspace
// autonomously or must wait for a human decision on Review. Campaigns can
// override each default; persona/connection/lane constraints can only make a
// kind stricter.

import { useCallback, useEffect, useState } from "react";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionEffectivePolicy,
  type ExternalActionKind,
  type ExternalActionPolicyView,
} from "@tuezday/contracts";
import { API_URL, apiFetch } from "@/lib/api";
import { actionKindLabel, effectivePolicyWorkflowStatus } from "@/lib/external-actions";
import { EmptyState } from "@/src/components/empty-state";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Icon } from "@/src/components/ui/icon";
import { Select } from "@/src/components/ui/input";
import styles from "./automation.module.css";

type PolicyDraft = Record<ExternalActionKind, ExternalActionEffectivePolicy>;

function draftFrom(view: ExternalActionPolicyView): PolicyDraft {
  const draft = {} as PolicyDraft;
  for (const kind of EXTERNAL_ACTION_KINDS) {
    // Workspace rules are always concrete (the contract forbids inherit at
    // workspace scope); treat a missing row as the safe default.
    const stored = view.rules.find((rule) => rule.actionKind === kind);
    draft[kind] = (stored?.rule as ExternalActionEffectivePolicy | undefined) ?? "human_required";
  }
  return draft;
}

export function ActionPolicy({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<ExternalActionPolicyView | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/workspaces/${workspaceId}/external-action-policies?scope=workspace&scopeId=${workspaceId}`,
      );
      if (!res.ok) throw new Error("not found");
      const body = (await res.json()) as ExternalActionPolicyView;
      setView(body);
      setDraft(draftFrom(body));
      setError(null);
    } catch {
      setError(`Could not load action permissions from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setAnnouncement(null);
    try {
      const res = await apiFetch(`/workspaces/${workspaceId}/external-action-policies`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "workspace",
          scopeId: workspaceId,
          expectedUpdatedAt: view?.updatedAt ?? null,
          rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({
            actionKind,
            rule: draft[actionKind],
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          current?: ExternalActionPolicyView;
        } | null;
        if (res.status === 409 && body?.current) setView(body.current);
        setAnnouncement(body?.message ?? "Could not save action permissions.");
        return;
      }
      const body = (await res.json()) as ExternalActionPolicyView;
      setView(body);
      setDraft(draftFrom(body));
      setAnnouncement("Action permissions saved.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="error">{error}</p>;

  const dirty =
    view !== null &&
    draft !== null &&
    EXTERNAL_ACTION_KINDS.some((kind) => draftFrom(view)[kind] !== draft[kind]);

  return (
    <Card>
      <h2 className={styles.head}>
        <Icon name="status-review" size="sm" /> Action permissions
      </h2>
      <p className="subtitle">
        The guardrails above tune cadence — how often automation drafts and posts. Permission is a
        separate decision: whether each kind of external action may go out on its own, or must wait
        for your sign-off on Review. Campaigns can override each default.
      </p>
      {!view || !draft ? (
        <EmptyState description="Loading…" />
      ) : (
        <>
          <div className={styles.policyGrid}>
            {EXTERNAL_ACTION_KINDS.map((kind) => {
              const effective = view.effective.find((entry) => entry.actionKind === kind);
              return (
                <div key={kind} className={styles.policyRow}>
                  <span className={styles.policyKind}>{actionKindLabel(kind)}</span>
                  <Select
                    aria-label={`${actionKindLabel(kind)} permission`}
                    value={draft[kind]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [kind]: e.target.value as ExternalActionEffectivePolicy,
                      })
                    }
                  >
                    <option value="human_required">Human required</option>
                    <option value="autonomous">Autonomous</option>
                  </Select>
                  {effective && (
                    <WorkflowStatusBadge
                      status={effectivePolicyWorkflowStatus(effective.policy.effective)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className={styles.policySave}>
            <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save action permissions"}
            </Button>
          </div>
        </>
      )}
      <p aria-live="polite" className={announcement ? styles.announcement : styles.announcementEmpty}>
        {announcement}
      </p>
    </Card>
  );
}
