import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const inboxQueue = read("app/workspaces/[id]/review/_components/inbox-queue.tsx");
const launchesPage = read("app/workspaces/[id]/launches/page.tsx");
const adLaunchesPage = read("app/workspaces/[id]/ad-launches/page.tsx");

describe("action origin surfaces source contract", () => {
  it("parse the external action submission envelope", () => {
    for (const source of [inboxQueue, launchesPage, adLaunchesPage]) {
      expect(source).toContain("ExternalActionSubmission");
      expect(source).toContain("submissionNote");
      expect(source).toContain('from "@/lib/external-actions"');
    }
  });

  it("link queued and blocked actions to the Review authorization queue", () => {
    for (const source of [inboxQueue, launchesPage, adLaunchesPage]) {
      expect(source).toContain("actionAuthorizationHref");
    }
  });

  it("inbox posts replies through the governed route and keeps approval separate", () => {
    expect(inboxQueue).toContain("post-reply");
    expect(inboxQueue).toContain("/approve");
    expect(inboxQueue).toContain("externalActionId");
  });

  it("launches parse batch dispatch submissions and keep the email CSV export", () => {
    expect(launchesPage).toContain("submissions");
    expect(launchesPage).not.toContain("body.results");
    expect(launchesPage).toContain("export.csv");
    expect(launchesPage).toContain('searchParams.get("launch")');
    expect(launchesPage).toContain("externalActionId");
    expect(launchesPage).toContain("Send from Tuezday");
    expect(launchesPage).toContain("Download CSV");
    expect(launchesPage).toContain("EmailPermissionControl");
    expect(launchesPage).toContain("EmailSendStatus");
  });

  it("ad launches keep the setup approval gate and surface the governing action", () => {
    expect(adLaunchesPage).toContain("Submit for approval");
    // The gate approves the ad's setup; it does not authorize the spend.
    expect(adLaunchesPage).toContain("Approve setup");
    expect(adLaunchesPage).not.toContain("Approve spend");
    expect(adLaunchesPage).toContain("externalActionId");
  });

  it("ad launches keep setup approval and spend authorization as two records", () => {
    expect(adLaunchesPage).toContain("Setup approvals");
    expect(adLaunchesPage).toContain("who approved this ad's setup");
    expect(adLaunchesPage).toContain("Spend authorization");
    expect(adLaunchesPage).toContain("who authorized this spend");
    expect(adLaunchesPage).toContain("Open the spend authorization");
  });

  it("ad launches never claim a person authorized an autonomous launch", () => {
    expect(adLaunchesPage).toContain("no person authorizes it");
    expect(adLaunchesPage).toContain("the policy does, and the action records who proposed it");
  });

  it("ad launches render retired launch rows as history, not as authorizations", () => {
    expect(adLaunchesPage).toContain("SETUP_DECISION_LABELS");
    expect(adLaunchesPage).toContain('decision.action === "launch"');
    expect(adLaunchesPage).toContain("Historical row");
    expect(adLaunchesPage).toContain("never recorded who authorized the spend");
  });

  // Sprint 54 final review (M-3) — the retired `launch` row was written
  // automatically. Printing "by <actor>" beside it names a person for
  // something no person authorized: the exact claim this sprint removed.
  it("ad launches attach no name to a historical launch row", () => {
    expect(adLaunchesPage).toContain('decision.action !== "launch"');
    // Real gate verbs keep their attribution — those were human decisions.
    expect(adLaunchesPage).toContain("by {decision.actor}");
    // …and the attribution is never unconditional.
    expect(adLaunchesPage).not.toContain('</strong> by{" "}');
  });

  // Sprint 54 final review (M-4) — under an autonomous policy a dispatch-time
  // guard block also returns `blocked` from propose, with `authorizedAt`
  // already stamped. "Refused when it was proposed" is only true when nothing
  // was authorized.
  it("ad launches tell proposal-time blocks apart from post-authorization ones", () => {
    expect(adLaunchesPage).toContain("submission.action.authorizedAt === null");
    expect(adLaunchesPage).toContain("Refused when it was proposed");
    expect(adLaunchesPage).toContain("Authorized, then refused before it reached the platform");
  });

  it("ad launches say guardrails refuse at proposal and do not overclaim governance", () => {
    expect(adLaunchesPage).toContain("refused when it is proposed");
    expect(adLaunchesPage).toContain("before anyone is asked to authorize it");
    expect(adLaunchesPage).toContain("change spend without recording a decision");
    expect(adLaunchesPage).not.toContain("nothing goes live without a green light");
  });
});
