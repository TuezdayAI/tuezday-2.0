import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(
  new URL("../app/workspaces/[id]/ad-launches/page.tsx", import.meta.url),
  "utf8",
);

describe("governed ad mutation shell", () => {
  it("offers separate budget and targeting proposals only from the owning surface", () => {
    expect(shell).toContain("Change budget");
    expect(shell).toContain("Change targeting");
    expect(shell).toContain("provider-state");
    expect(shell).toContain("beforeDailyBudgetCents");
    expect(shell).toContain("Countries added");
  });

  it("keeps authorization in Review and preserves one request id across retries", () => {
    expect(shell).toContain("externalActionHref");
    expect(shell).toContain("Open authorization");
    expect(shell).toContain("idempotencyKey");
    expect(shell).toContain("crypto.randomUUID()");
  });
});
