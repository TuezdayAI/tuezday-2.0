import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../app/workspaces/[id]/connectors/page.tsx", import.meta.url),
  "utf8",
);

const instagramHint = page.match(/instagram:\s*\([\s\S]*?\n\s*\),\n\s*gmail:/)?.[0];

describe("Instagram Login operator setup copy", () => {
  it("describes direct Instagram Login and rejects the legacy Facebook flow", () => {
    expect(instagramHint).toBeDefined();
    expect(instagramHint).toContain("Instagram API with Instagram Login");
    expect(instagramHint).toContain("instagram_business_basic");
    expect(instagramHint).toContain("instagram_business_content_publish");
    expect(instagramHint).toContain("INSTAGRAM_CLIENT_ID");
    expect(instagramHint).toContain("INSTAGRAM_CLIENT_SECRET");
    expect(instagramHint).not.toContain("Instagram Graph API");
    expect(instagramHint).not.toContain("Facebook Page");
    expect(instagramHint).not.toContain("Facebook Login");
    expect(instagramHint).not.toContain("Facebook app id/secret");
  });
});
