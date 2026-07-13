import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../app/onboarding/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/onboarding/onboarding.css", import.meta.url), "utf8");

describe("onboarding setup-skip source contract", () => {
  it("gates the secondary action behind the explicit public flag", () => {
    expect(page).toContain("NEXT_PUBLIC_ENABLE_SETUP_SKIP");
    expect(page).toContain("isSetupSkipEnabled");
    expect(page).toContain("Skip setup for now");
  });

  it("uses the canonical request builder and existing workspace navigation", () => {
    expect(page).toContain("buildSetupSkipRequest(workspaceId)");
    expect(page).toContain("const [skipping, setSkipping]");
    expect(page).toContain("Could not skip setup");
    expect(page).toContain("Skipping…");
    expect(page).toContain("router.push(`/workspaces/${targetId}`)");
    expect(css).toContain(".ob-skip");
  });

  it("uses the resume workspace as the initial skip target", () => {
    expect(page).toContain(
      "const [workspaceId, setWorkspaceId] = useState<string | null>(resumeId)",
    );
  });
});
