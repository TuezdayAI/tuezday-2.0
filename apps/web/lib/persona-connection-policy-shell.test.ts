import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const resolver = readFileSync(
  new URL("../app/workspaces/[id]/resolver/page.tsx", import.meta.url),
  "utf8",
);
const connectors = readFileSync(
  new URL("../app/workspaces/[id]/connectors/page.tsx", import.meta.url),
  "utf8",
);

describe("persona and connection policy ownership", () => {
  it("mounts persona policy only for the persona being edited", () => {
    expect(resolver).toContain("ScopedActionPolicy");
    expect(resolver).toContain('scope="persona"');
    expect(resolver).toContain("scopeId={p.id}");
    expect(resolver).toContain("editingId === p.id");
  });

  it("mounts connection policy in the expanded account detail", () => {
    expect(connectors).toContain("ScopedActionPolicy");
    expect(connectors).toContain('scope="connection"');
    expect(connectors).toContain("scopeId={connection.id}");
    expect(connectors).toContain("Action permission");
    expect(connectors).toContain("policyConnectionId === connection.id");
  });
});
