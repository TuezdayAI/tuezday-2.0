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

  it("ad launches keep the spend approval gate and surface the governing action", () => {
    expect(adLaunchesPage).toContain("Submit for approval");
    expect(adLaunchesPage).toContain("Approve spend");
    expect(adLaunchesPage).toContain("externalActionId");
  });
});
