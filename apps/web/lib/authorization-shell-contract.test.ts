import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queueSource = readFileSync(
  new URL("../app/workspaces/[id]/review/_components/authorizations-queue.tsx", import.meta.url),
  "utf8",
);
const queueStyles = readFileSync(
  new URL(
    "../app/workspaces/[id]/review/_components/authorizations-queue.module.css",
    import.meta.url,
  ),
  "utf8",
);
const reviewPage = readFileSync(
  new URL("../app/workspaces/[id]/review/page.tsx", import.meta.url),
  "utf8",
);

describe("authorization queue shell contract", () => {
  it("speaks the canonical status vocabulary through the shared helpers", () => {
    expect(queueSource).toContain("WorkflowStatusBadge");
    expect(queueSource).toContain("externalActionWorkflowStatus");
    expect(queueSource).toContain('from "@/lib/external-actions"');
    expect(queueSource).toContain("policyExplanation");
    expect(queueSource).toContain("actionRecoveryHref");
  });

  it("fetches the filtered queue and the selected action's full detail", () => {
    expect(queueSource).toContain("/external-actions?");
    expect(queueSource).toMatch(/external-actions\/\$\{/);
    expect(queueSource).toContain('searchParams.get("action")');
  });

  it("authorizes and denies through the action routes, guarding double submits", () => {
    expect(queueSource).toMatch(/external-actions\/\$\{actionId\}\/\$\{decision\}/);
    expect(queueSource).toContain('decide(selected.id, "authorize")');
    expect(queueSource).toContain('decide(selected.id, "deny")');
    expect(queueSource).toContain("/repropose");
    expect(queueSource).toContain("busy");
    expect(queueSource).toContain('aria-live="polite"');
  });

  it("previews only explicit selected authorizations before one batch confirmation", () => {
    expect(queueSource).toContain("selectedAuthorizationIds");
    expect(queueSource).toContain('type="checkbox"');
    expect(queueSource).toContain("Preview ");
    expect(queueSource).toContain("authorizations");
    expect(queueSource).toContain("external-action-batches");
    expect(queueSource).toContain("Authorize included actions");
    expect(queueSource).toContain("partially_completed");
    expect(queueSource).not.toContain("Approve selected content");
  });

  it("previews bounded campaign authorizations from the active campaign filter", () => {
    expect(queueSource).toContain("Preview campaign authorizations");
    expect(queueSource).toContain("campaignBatchSelection");
    expect(queueSource).toContain("continuationCount");
    expect(queueSource).toContain("Actions created after this preview are not included");
    expect(queueSource).toMatch(/external-action-batches\/\$\{batchDetail\.batch\.id\}\/authorize/);
  });

  // Sprint 52 — a collapsed publish action is authorized at propose time and
  // never enters the authorization_required queue, so the only place a founder
  // can still stop it is the pre-dispatch window on the Scheduled filter.
  it("offers a withdrawal for an authorized action that has not dispatched", () => {
    // The pre-dispatch window, and only it — `succeeded` is never in the list.
    // This hardcoded list is the real gate: the state machine also permits
    // `cancelled` from `blocked`, `failed` and the queue states, which this
    // surface deliberately does not offer a withdrawal for.
    expect(queueSource).toContain("WITHDRAWABLE_STATUSES");
    expect(queueSource).toMatch(/WITHDRAWABLE_STATUSES[^=]*=\s*\["authorized", "scheduled"\]/);
    // The contracts state machine still has the final say on legality.
    expect(queueSource).toContain('canTransitionExternalAction(action.status, "cancelled")');
    expect(queueSource).toContain("withdrawable(selected)");
    expect(queueSource).toContain('decide(selected.id, "cancel")');
    expect(queueSource).toContain("Withdraw authorization");
    // Reachable: an authorized action that has not dispatched has its own filter.
    expect(queueSource).toContain('authorized: "Authorized"');
  });

  // Sprint 52 — a publish sitting in this queue means the draft approval did
  // not carry through. The founder should be able to tell why they are being
  // asked twice.
  it("says why a second decision is still being asked for", () => {
    expect(queueSource).toContain("secondGateExplanation");
    expect(queueSource).toContain("secondGate && ");
  });

  it("names when an authorization was granted without a missing preposition", () => {
    expect(queueSource).toContain("Already authorized");
    expect(queueSource).toMatch(/` on \$\{new Date\(selected\.authorizedAt\)\.toLocaleString\(\)\}`/);
    expect(queueSource).toContain("You can still take that back until it dispatches.");
  });

  it("uses the canonical ready, attention, and blocked result tokens", () => {
    expect(queueStyles).toContain("--status-ready-ink");
    expect(queueStyles).toContain("--status-attention-ink");
    expect(queueStyles).toContain("--status-blocked-ink");
    expect(queueStyles).not.toContain("--status-success");
    expect(queueStyles).not.toContain("--status-warning");
  });

  it("labels the policy, guardrail, and decision regions", () => {
    expect(queueSource).toContain('aria-label="Policy"');
    expect(queueSource).toContain('aria-label="Guardrail"');
    expect(queueSource).toContain('aria-label="Decisions"');
  });

  it("keeps action authorization separate from content approval", () => {
    // No content-approval mutations or combined copy in this surface.
    expect(queueSource).not.toContain("/drafts/");
    expect(queueSource).not.toMatch(/Approve (and|&) publish/i);
    expect(queueSource).not.toContain("pending_review");
  });

  it("is mounted as a Review tab with its queue count", () => {
    expect(reviewPage).toContain("AuthorizationsQueue");
    expect(reviewPage).toContain('tab: "authorizations"');
    expect(reviewPage).toContain("status=authorization_required");
  });
});
