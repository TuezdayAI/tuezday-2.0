"use client";

import { useState } from "react";
import type {
  EmailDelivery,
  EmailDeliveryStatus,
  EmailPermissionStatus,
  EmailRecipientPermission,
  ExternalActionSubmission,
  WorkflowStatus,
} from "@tuezday/contracts";
import { EMAIL_DELIVERY_STATUSES } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  emailDeliveryCopy,
  emailDeliveryWorkflowStatus,
} from "@/lib/execution-results";
import {
  actionAuthorizationHref,
  actionRecoveryHref,
  externalActionWorkflowStatus,
  submissionNote,
} from "@/lib/external-actions";
import { WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Button, ButtonLink } from "@/src/components/ui/button";
import styles from "./email-send-status.module.css";

const PERMISSION_VIEW: Record<
  EmailPermissionStatus,
  { status: WorkflowStatus; label: string; copy: string }
> = {
  unknown: { status: "setup_required", label: "Permission required", copy: "Native email is not allowed until you explicitly permit this recipient." },
  allowed: { status: "approved", label: "Native email allowed", copy: "This recipient may receive governed native email from this workspace." },
  suppressed: { status: "policy_blocked", label: "Email suppressed", copy: "Native email is blocked for this recipient." },
};

const DELIVERY_LABEL: Record<EmailDelivery["status"], string> = {
  queued: "Queued",
  accepted: "Accepted",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Spam complaint",
  failed: "Failed",
};

interface EmailPermissionControlProps {
  workspaceId: string;
  email: string;
  status: EmailPermissionStatus;
  onChange: (status: EmailPermissionStatus) => void;
}

export function EmailPermissionControl({
  workspaceId,
  email,
  status,
  onChange,
}: EmailPermissionControlProps) {
  const [saving, setSaving] = useState<EmailPermissionStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const view = PERMISSION_VIEW[status];

  async function update(next: Extract<EmailPermissionStatus, "allowed" | "suppressed">) {
    setSaving(next);
    setAnnouncement("");
    try {
      const response = await apiFetch(
        `/workspaces/${workspaceId}/email-permissions/${encodeURIComponent(email.toLowerCase())}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        },
      );
      if (!response.ok) throw new Error("permission_update_failed");
      const permission = (await response.json()) as EmailRecipientPermission;
      onChange(permission.status);
      setAnnouncement(
        permission.status === "allowed"
          ? `Native email allowed for ${permission.normalizedEmail}.`
          : `Email suppressed for ${permission.normalizedEmail}.`,
      );
    } catch {
      setAnnouncement("Email permission could not be updated. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={styles.permission} aria-label={`Native email permission for ${email}`}>
      <div className={styles.permissionSummary}>
        <div>
          <p className={styles.kicker}>Recipient permission</p>
          <p className={styles.address}>{email}</p>
        </div>
        <WorkflowStatusBadge status={view.status} label={view.label} />
      </div>
      <p className={styles.copy}>{view.copy}</p>
      <div className={styles.actions} role="group" aria-label="Change recipient permission">
        {status !== "allowed" && (
          <Button
            variant="primary"
            size="standard"
            loading={saving === "allowed"}
            disabled={saving !== null}
            onClick={() => void update("allowed")}
          >
            Allow native email
          </Button>
        )}
        {status !== "suppressed" && (
          <Button
            variant="danger"
            size="standard"
            loading={saving === "suppressed"}
            disabled={saving !== null}
            onClick={() => void update("suppressed")}
          >
            Suppress email
          </Button>
        )}
      </div>
      <p className={styles.announcement} aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

interface EmailSendStatusProps {
  submission: ExternalActionSubmission;
  delivery: EmailDelivery | null;
}

const RECOVERY_ACTION_STATUSES = new Set(["blocked", "stale", "failed"]);
const FAILED_DELIVERY_STATUSES = new Set<EmailDelivery["status"]>([
  "bounced",
  "complained",
  "failed",
]);

export function EmailSendStatus({ submission, delivery }: EmailSendStatusProps) {
  const [copied, setCopied] = useState(false);
  const receiptStatus =
    submission.execution?.kind === "email_delivery" &&
    (EMAIL_DELIVERY_STATUSES as readonly string[]).includes(submission.execution.status)
      ? (submission.execution.status as EmailDeliveryStatus)
      : null;
  const deliveryStatus = delivery?.status ?? receiptStatus;
  const workflowStatus = deliveryStatus
    ? emailDeliveryWorkflowStatus(deliveryStatus)
    : externalActionWorkflowStatus(submission.action);
  const label = deliveryStatus ? DELIVERY_LABEL[deliveryStatus] : undefined;
  const copy = deliveryStatus ? emailDeliveryCopy(deliveryStatus) : submissionNote(submission);
  const needsRecovery = deliveryStatus
    ? FAILED_DELIVERY_STATUSES.has(deliveryStatus)
    : RECOVERY_ACTION_STATUSES.has(submission.action.status);

  async function copyProviderId() {
    if (!delivery?.providerMessageId) return;
    await navigator.clipboard.writeText(delivery.providerMessageId);
    setCopied(true);
  }

  return (
    <section className={styles.delivery} aria-label="Native email delivery status">
      <div className={styles.deliverySummary} aria-live="polite" aria-atomic="true">
        <WorkflowStatusBadge status={workflowStatus} label={label} />
        <p>{copy}</p>
      </div>

      {delivery?.lastError && <p className={styles.error}>{delivery.lastError}</p>}

      {delivery?.providerMessageId && (
        <div className={styles.providerMetadata}>
          <span>Resend message ID</span>
          <code>{delivery.providerMessageId}</code>
          <Button variant="tertiary" size="compact" onClick={() => void copyProviderId()}>
            {copied ? "Copied" : "Copy ID"}
          </Button>
        </div>
      )}

      <div className={styles.actions}>
        <ButtonLink
          href={actionAuthorizationHref(submission.action)}
          variant={needsRecovery ? "tertiary" : "secondary"}
          size="standard"
        >
          Review action
        </ButtonLink>
        {needsRecovery && (
          <ButtonLink
            href={actionRecoveryHref(submission.action)}
            variant="primary"
            size="standard"
          >
            Fix and retry
          </ButtonLink>
        )}
      </div>
    </section>
  );
}
