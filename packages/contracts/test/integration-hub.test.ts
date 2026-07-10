import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PROVIDERS,
  connectorHubGroups,
  integrationProgress,
  type ConnectorProvider,
} from "../src";

const providerStub = (key: string, categories?: ConnectorProvider["categories"]): ConnectorProvider => ({
  key,
  label: key,
  nangoProvider: key,
  authMode: "api_key",
  ...(categories ? { categories } : {}),
});

const connectionStub = (providerKey: string, status: "connected" | "error" | "disconnected") =>
  ({ providerKey, status }) as Parameters<typeof integrationProgress>[1][number];

describe("connectorHubGroups", () => {
  it("groups the real registry by capability in hub order, uncategorized last", () => {
    const groups = connectorHubGroups(CONNECTOR_PROVIDERS);
    expect(groups.map((g) => g.category)).toEqual(["social", "ads", "crm", "outbound", "other"]);
    expect(groups[0]?.providers.map((p) => p.key)).toEqual([
      "reddit",
      "linkedin",
      "twitter",
      "instagram",
    ]);
    expect(groups.find((g) => g.category === "other")?.providers.map((p) => p.key)).toEqual([
      "slack",
      "custom",
    ]);
  });

  it("names each group by what it unlocks", () => {
    const byCategory = Object.fromEntries(
      connectorHubGroups(CONNECTOR_PROVIDERS).map((g) => [g.category, g.title]),
    );
    expect(byCategory.social).toBe("Publishing");
    expect(byCategory.ads).toBe("Ads");
    expect(byCategory.crm).toBe("CRM");
    expect(byCategory.outbound).toBe("Outbound");
  });

  it("omits groups with no providers", () => {
    const groups = connectorHubGroups([providerStub("a", ["crm"])]);
    expect(groups.map((g) => g.category)).toEqual(["crm"]);
  });
});

describe("integrationProgress", () => {
  const providers = [
    providerStub("linkedin", ["social"]),
    providerStub("reddit", ["social"]),
    providerStub("meta_ads", ["ads"]),
    providerStub("freshsales", ["crm"]),
    providerStub("smartlead", ["outbound"]),
    providerStub("custom"),
  ];

  it("counts capabilities, not accounts: two social connections = one connected capability", () => {
    const progress = integrationProgress(providers, [
      connectionStub("linkedin", "connected"),
      connectionStub("reddit", "connected"),
    ]);
    expect(progress).toEqual({ connected: 1, total: 4 });
  });

  it("ignores non-connected statuses and uncategorized providers", () => {
    const progress = integrationProgress(providers, [
      connectionStub("freshsales", "error"),
      connectionStub("custom", "connected"),
    ]);
    expect(progress).toEqual({ connected: 0, total: 4 });
  });

  it("reports full progress when every capability has a live connection", () => {
    const progress = integrationProgress(providers, [
      connectionStub("linkedin", "connected"),
      connectionStub("meta_ads", "connected"),
      connectionStub("freshsales", "connected"),
      connectionStub("smartlead", "connected"),
    ]);
    expect(progress).toEqual({ connected: 4, total: 4 });
  });
});
