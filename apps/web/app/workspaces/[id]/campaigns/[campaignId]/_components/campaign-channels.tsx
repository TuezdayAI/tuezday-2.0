"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  Audience,
  CampaignLaneRevisionView,
  CampaignPlanDetail,
  Channel,
  Connection,
  Persona,
  UpsertCampaignLaneRevisionInput,
} from "@tuezday/contracts";
import { editablePlan, formatLaneSchedule, laneStatus } from "@/lib/campaign-control-plane";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { ScopedActionPolicy } from "@/src/components/scoped-action-policy";
import { CampaignLaneForm } from "./campaign-lane-form";
import styles from "../campaign-workspace.module.css";

interface CampaignChannelsProps {
  workspaceId: string;
  revisions: CampaignPlanDetail[];
  currentPlanRevisionId: string | null;
  campaignChannels: Channel[];
  personas: Persona[];
  audiences: Audience[];
  connections: Connection[];
  busy: boolean;
  onSaveLane(planRevisionId: string, input: UpsertCampaignLaneRevisionInput): Promise<void>;
}

export function CampaignChannels({
  workspaceId,
  revisions,
  currentPlanRevisionId,
  campaignChannels,
  personas,
  audiences,
  connections,
  busy,
  onSaveLane,
}: CampaignChannelsProps) {
  const draft = editablePlan(revisions);
  const active = revisions.find(({ plan }) => plan.id === currentPlanRevisionId) ?? null;
  const selected = draft ?? active;
  const [editing, setEditing] = useState<CampaignLaneRevisionView | "new" | null>(null);
  const [policyLaneId, setPolicyLaneId] = useState<string | null>(null);
  const policyLanes = active?.lanes ?? [];
  const personaNames = new Map(personas.map((persona) => [persona.id, persona.name]));
  const audienceNames = new Map(audiences.map((audience) => [audience.id, audience.name]));
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));

  if (!selected) {
    return (
      <section className={styles.placeholderPanel}>
        <p className={styles.panelKicker}>Channels</p>
        <h2>Initialize the campaign plan first</h2>
        <p>Channel commitments are versioned with the campaign plan.</p>
      </section>
    );
  }

  return (
    <section className={styles.channelsWorkspace}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.panelKicker}>Channels · Plan v{selected.plan.revision}</p>
          <h2>Campaign commitments</h2>
          <p>Each channel maps a persona, audience, format, destination, and bounded schedule.</p>
        </div>
        {draft ? (
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Icon name="add" size="sm" /> Add channel
          </Button>
        ) : (
          <Link className={styles.planPrompt} href="?tab=plan">Create a plan revision to edit channels</Link>
        )}
      </div>

      {!draft && (
        <div className={styles.readOnlyNotice} role="status">
          <Icon name="info" size="sm" />
          <span>The active plan is immutable. Create a plan revision to edit channels.</span>
        </div>
      )}

      {editing && draft && (
        <div className={styles.editorPanel}>
          <div className={styles.editorHeading}>
            <div><p className={styles.panelKicker}>Draft channel</p><h3>{editing === "new" ? "Add a campaign channel" : `Edit ${editing.name}`}</h3></div>
            <span>Changes remain inside draft plan v{draft.plan.revision} until activation.</span>
          </div>
          <CampaignLaneForm
            initial={editing === "new" ? null : editing}
            campaignChannels={campaignChannels}
            personas={personas}
            audiences={audiences}
            connections={connections}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              await onSaveLane(draft.plan.id, input);
              setEditing(null);
            }}
          />
        </div>
      )}

      {selected.lanes.length === 0 ? (
        <div className={styles.emptyChannels}>
          <Icon name="campaigns" size="lg" />
          <h3>No channel commitments</h3>
          <p>Add the first channel to define what Tuezday should prepare and where it can execute.</p>
        </div>
      ) : (
        <div className={styles.channelCards}>
          {selected.lanes.map((lane) => {
            const persona = personaNames.get(lane.personaId);
            const audience = lane.audienceId ? audienceNames.get(lane.audienceId) : null;
            const connection = lane.publishingConnectionId
              ? connectionsById.get(lane.publishingConnectionId)
              : null;
            const referenceMissing = !persona || (lane.audienceId && !audience) ||
              (lane.publishingConnectionId && !connection);
            return (
              <article key={lane.id} className={styles.channelCard}>
                <div className={styles.channelHeader}>
                  <div><p>{lane.channel} · {lane.format}</p><h3>{lane.name}</h3></div>
                  <WorkflowStatusBadge status={referenceMissing ? "setup_required" : laneStatus(lane.status)} />
                </div>
                <dl className={styles.channelFacts}>
                  <div><dt>Persona</dt><dd>{persona ?? <Link href={`/workspaces/${workspaceId}/brain`}>Setup required</Link>}</dd></div>
                  <div><dt>Audience</dt><dd>{audience ?? (lane.audienceId ? <Link href={`/workspaces/${workspaceId}/lists`}>Setup required</Link> : "Campaign audience")}</dd></div>
                  <div><dt>Destination</dt><dd>{connection?.displayName ?? <Link href={`/workspaces/${workspaceId}/connectors`}>Select a connection</Link>}</dd></div>
                  <div><dt>Target</dt><dd>{lane.providerTarget || "Provider default"}</dd></div>
                </dl>
                <p className={styles.scheduleSummary}>{formatLaneSchedule(lane)}</p>
                {draft && (
                  <Button variant="tertiary" size="compact" onClick={() => setEditing(lane)}>
                    <Icon name="edit" size="sm" /> Edit configuration
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {policyLanes.length > 0 && (
        <section className={styles.lanePolicies} aria-labelledby="active-lane-permissions">
          <div className={styles.lanePoliciesHeading}>
            <div>
              <p className={styles.panelKicker}>Active lane safety</p>
              <h3 id="active-lane-permissions">Action permission for active lanes</h3>
            </div>
            <p>
              The active plan is immutable; action permission is stored separately and can only
              tighten workspace and campaign permission. Inactive and draft revision policy stays
              read-only.
            </p>
          </div>
          <div className={styles.lanePolicyList}>
            {policyLanes.map((lane) => (
              <details
                key={lane.id}
                className={styles.lanePolicyDetail}
                open={policyLaneId === lane.id}
                onToggle={(event) =>
                  setPolicyLaneId((current) =>
                    event.currentTarget.open
                      ? lane.id
                      : current === lane.id
                        ? null
                        : current,
                  )
                }
              >
                <summary>
                  <span>{lane.name}</span>
                  <span>{lane.channel} · {lane.format}</span>
                </summary>
                {policyLaneId === lane.id && (
                  <div className={styles.lanePolicyEditor}>
                    <ScopedActionPolicy
                      workspaceId={workspaceId}
                      scope="lane"
                      scopeId={lane.id}
                      title={`Action permission for this lane — ${lane.name}`}
                    />
                  </div>
                )}
              </details>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
