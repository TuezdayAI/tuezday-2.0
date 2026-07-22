import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(
  new URL("../app/workspaces/[id]/connectors/page.tsx", import.meta.url),
  "utf8",
);

describe("verified email sender shell", () => {
  it("owns sender setup and verification in Connections", () => {
    expect(shell).toContain("Verified email sender");
    expect(shell).toContain("DNS records");
    expect(shell).toContain("Check verification");
    expect(shell).toContain("/email-sender");
  });

  it("asks for sender identity but never workspace-owned provider credentials", () => {
    expect(shell).toContain("From name");
    expect(shell).toContain("From local part");
    expect(shell).toContain("Reply-to address");
    expect(shell).not.toContain("RESEND_API_KEY");
    expect(shell).not.toContain("Resend API key");
  });

  it("renders verification failures and public DNS values for recovery", () => {
    expect(shell).toContain("lastError");
    expect(shell).toContain("dnsRecords");
    expect(shell).toContain("record.value");
  });
});
