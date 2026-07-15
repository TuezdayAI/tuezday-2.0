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
