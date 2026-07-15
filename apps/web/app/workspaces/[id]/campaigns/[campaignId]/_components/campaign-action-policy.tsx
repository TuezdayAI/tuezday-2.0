"use client";
// Campaign action-permission overrides. The campaign's mode sets automation
// cadence; this panel sets permission — whether each external action kind may
// leave this campaign autonomously or must wait for a human decision. Each
// kind can inherit the workspace default (by deleting the stored override) or
// pin its own rule; persona/connection/lane constraints are shown read-only.

import { useCallback, useEffect, useState } from "react";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionKind,
  type ExternalActionPolicyContribution,
  type ExternalActionPolicyRule,
  type ExternalActionPolicyRuleRecord,
  type EffectiveExternalActionPolicy,
} from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  actionKindLabel,
  effectivePolicyWorkflowStatus,
  policyScopeLabel,
} from "@/lib/external-actions";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Select } from "@/src/components/ui/input";
import styles from "../campaign-workspace.module.css";

interface CampaignPolicyView {
  rules: ExternalActionPolicyRuleRecord[];
  effective: Array<{
    actionKind: ExternalActionKind;
    policy: EffectiveExternalActionPolicy;
  }>;
}

type PolicyDraft = Record<ExternalActionKind, ExternalActionPolicyRule>;

function draftFrom(view: CampaignPolicyView): PolicyDraft {
  const draft = {} as PolicyDraft;
  for (const kind of EXTERNAL_ACTION_KINDS) {
    draft[kind] = view.rules.find((rule) => rule.actionKind === kind)?.rule ?? "inherit";
  }
  return draft;
}

/** Non-campaign rules that shape the outcome: the workspace default plus any
 * persona/connection/lane constraints. Read-only here — edit them at source. */
function readOnlyContributors(
  policy: EffectiveExternalActionPolicy,
): ExternalActionPolicyContribution[] {
  return policy.contributingRules.filter(
    (rule) => rule.scope !== "campaign" && rule.rule !== "inherit",
  );
}

interface CampaignActionPolicyProps {
  workspaceId: string;
  campaignId: string;
}

export function CampaignActionPolicy({ workspaceId, campaignId }: CampaignActionPolicyProps) {
  const [view, setView] = useState<CampaignPolicyView | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(
      `/workspaces/${workspaceId}/external-action-policies?scope=campaign&scopeId=${campaignId}`,
    );
    if (!res.ok) return;
    const body = (await res.json()) as CampaignPolicyView;
    setView(body);
    setDraft(draftFrom(body));
  }, [workspaceId, campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!view || !draft || saving) return;
    setSaving(true);
    setAnnouncement(null);
    try {
      // One bounded batch: a single PUT for every pinned kind, plus a delete
      // per kind returned to inherit (dropping the row restores the default).
      const pinned = EXTERNAL_ACTION_KINDS.filter((kind) => draft[kind] !== "inherit");
      if (pinned.length > 0) {
        const res = await apiFetch(`/workspaces/${workspaceId}/external-action-policies`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "campaign",
            scopeId: campaignId,
            rules: pinned.map((actionKind) => ({ actionKind, rule: draft[actionKind] })),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          setAnnouncement(body?.message ?? "Could not save campaign action permissions.");
          return;
        }
      }
      const inheritRuleIds = view.rules
        .filter((rule) => draft[rule.actionKind] === "inherit")
        .map((rule) => rule.id);
      for (const ruleId of inheritRuleIds) {
        const res = await apiFetch(
          `/workspaces/${workspaceId}/external-action-policies/${ruleId}`,
          { method: "DELETE" },
        );
        if (!res.ok && res.status !== 404) {
          setAnnouncement("Could not reset a permission to the workspace default.");
          return;
        }
      }
      await load();
      setAnnouncement("Campaign action permissions saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!view || !draft) return null;

  const stored = draftFrom(view);
  const dirty = EXTERNAL_ACTION_KINDS.some((kind) => stored[kind] !== draft[kind]);

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.panelKicker}>Action permission</p>
          <h2>Who signs off</h2>
        </div>
      </div>
      <p className={styles.quietState}>
        Campaign mode sets the cadence of automated drafting. Permission is separate: it decides
        whether each kind of external action may go out from this campaign without a human
        decision. Inherit uses the workspace default.
      </p>
      <div className={styles.policyList}>
        {EXTERNAL_ACTION_KINDS.map((kind) => {
          const effective = view.effective.find((entry) => entry.actionKind === kind);
          const contributors = effective ? readOnlyContributors(effective.policy) : [];
          return (
            <div key={kind} className={styles.policyRow}>
              <span className={styles.policyKind}>{actionKindLabel(kind)}</span>
              <Select
                aria-label={`${actionKindLabel(kind)} permission`}
                value={draft[kind]}
                onChange={(e) =>
                  setDraft({ ...draft, [kind]: e.target.value as ExternalActionPolicyRule })
                }
              >
                <option value="inherit">Inherit workspace default</option>
                <option value="human_required">Human required</option>
                <option value="autonomous">Autonomous</option>
              </Select>
              {effective && (
                <WorkflowStatusBadge
                  status={effectivePolicyWorkflowStatus(effective.policy.effective)}
                />
              )}
              {contributors.length > 0 && (
                <p className={styles.policyContributors}>
                  {contributors
                    .map(
                      (rule) =>
                        `${policyScopeLabel(rule.scope)} (${rule.scopeLabel}): ${
                          rule.rule === "human_required" ? "human required" : "autonomous"
                        }`,
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.policySave}>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save permissions"}
        </Button>
      </div>
      <p
        aria-live="polite"
        className={announcement ? styles.policyAnnouncement : styles.policyAnnouncementEmpty}
      >
        {announcement}
      </p>
    </section>
  );
}
