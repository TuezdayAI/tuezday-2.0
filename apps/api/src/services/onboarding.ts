import { and, eq } from "drizzle-orm";
import type { OnboardingStep } from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, generations, workspaceMembers } from "../db/schema";
import { getBrain } from "./brain";
import { listConnections } from "./connections";

export interface OnboardingState {
  steps: OnboardingStep[];
  dismissed: boolean;
}

export function getOnboarding(db: Db, workspaceId: string, userId: string): OnboardingState {
  const workspaceStep: OnboardingStep = {
    key: "workspace",
    label: "Create workspace",
    done: true,
    cta: "/", 
  };

  const brainView = getBrain(db, workspaceId);
  const brainStep: OnboardingStep = {
    key: "brain",
    label: "Seed brain",
    done: brainView.completeness.percent > 0,
    cta: `/workspaces/${workspaceId}/brain`,
  };

  const conns = listConnections(db, workspaceId);
  const connectStep: OnboardingStep = {
    key: "connect",
    label: "Connect an app",
    done: conns.length > 0,
    cta: `/workspaces/${workspaceId}/settings/connections`,
  };

  const genCount = db
    .select({ id: generations.id })
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .limit(1)
    .all();
  const generateStep: OnboardingStep = {
    key: "generate",
    label: "First generation",
    done: genCount.length > 0,
    cta: `/workspaces/${workspaceId}/sandbox`,
  };

  const approvedDrafts = db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.state, "approved")))
    .limit(1)
    .all();
  const approveStep: OnboardingStep = {
    key: "approve",
    label: "First approval",
    done: approvedDrafts.length > 0,
    cta: `/workspaces/${workspaceId}/approvals`,
  };

  const steps = [workspaceStep, brainStep, connectStep, generateStep, approveStep];

  const member = db
    .select({ onboardingDismissedAt: workspaceMembers.onboardingDismissedAt })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .get();

  return {
    steps,
    dismissed: member?.onboardingDismissedAt != null,
  };
}

export function dismissOnboarding(db: Db, workspaceId: string, userId: string): void {
  db.update(workspaceMembers)
    .set({ onboardingDismissedAt: Date.now() })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .run();
}
