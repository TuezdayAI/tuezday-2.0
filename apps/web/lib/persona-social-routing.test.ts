import { describe, expect, it } from "vitest";
import type { Connection, PersonaSocialAccount } from "@tuezday/contracts";
import {
  defaultTargetForChannel,
  launchChannelReady,
  personaAccountOptions,
  primaryConnectionForChannel,
  providerForPersonaSocialChannel,
} from "./persona-social-routing";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const personaId = "00000000-0000-4000-8000-000000000002";

function connection(overrides: Partial<Connection>): Connection {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    workspaceId,
    providerKey: "linkedin",
    nangoConnectionId: "nango",
    config: {},
    displayName: "LinkedIn",
    externalAccountId: null,
    externalAccountName: null,
    externalAccountHandle: null,
    externalAccountUrl: null,
    status: "connected",
    lastCheckedAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function assignment(overrides: Partial<PersonaSocialAccount>): PersonaSocialAccount {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    workspaceId,
    personaId,
    connectionId: "00000000-0000-4000-8000-000000000010",
    providerKey: "linkedin",
    channel: "linkedin",
    isPrimary: false,
    defaultTarget: "feed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("persona social routing helpers", () => {
  it("maps social channels to connector provider keys", () => {
    expect(providerForPersonaSocialChannel("linkedin")).toBe("linkedin");
    expect(providerForPersonaSocialChannel("instagram")).toBe("instagram");
    expect(providerForPersonaSocialChannel("x")).toBe("twitter");
    expect(providerForPersonaSocialChannel("reddit")).toBe("reddit");
    expect(providerForPersonaSocialChannel("email")).toBeNull();
  });

  it("keeps all connected social accounts visible until a persona is selected", () => {
    const linkedIn = connection({
      id: "00000000-0000-4000-8000-000000000011",
      providerKey: "linkedin",
    });
    const instagram = connection({
      id: "00000000-0000-4000-8000-000000000012",
      providerKey: "instagram",
      displayName: "Instagram",
    });
    const assignments = [
      assignment({
        connectionId: linkedIn.id,
        providerKey: "linkedin",
        channel: "linkedin",
      }),
    ];

    expect(
      personaAccountOptions({
        connections: [linkedIn, instagram],
        assignments,
        personaId: "",
        channel: "linkedin",
      }).map((c) => c.id),
    ).toEqual([linkedIn.id, instagram.id]);

    expect(
      personaAccountOptions({
        connections: [linkedIn, instagram],
        assignments,
        personaId,
        channel: "linkedin",
      }).map((c) => c.id),
    ).toEqual([linkedIn.id]);
  });

  it("resolves only the connected primary account for a persona channel", () => {
    const primary = connection({ id: "00000000-0000-4000-8000-000000000013" });
    const disconnected = connection({
      id: "00000000-0000-4000-8000-000000000014",
      status: "disconnected",
    });
    const assignments = [
      assignment({
        id: "00000000-0000-4000-8000-000000000023",
        connectionId: primary.id,
        isPrimary: true,
      }),
      assignment({
        id: "00000000-0000-4000-8000-000000000024",
        connectionId: disconnected.id,
        isPrimary: true,
      }),
    ];

    expect(primaryConnectionForChannel([primary, disconnected], assignments, "linkedin")?.id).toBe(
      primary.id,
    );
  });

  it("requires persona primary assignments for launch social channels", () => {
    const linkedIn = connection({ id: "00000000-0000-4000-8000-000000000015" });
    const assignmentsByPersona = {
      [personaId]: [
        assignment({
          connectionId: linkedIn.id,
          providerKey: "linkedin",
          channel: "linkedin",
          isPrimary: true,
        }),
      ],
    };

    expect(launchChannelReady("email", [linkedIn], personaId, assignmentsByPersona)).toBe(true);
    expect(launchChannelReady("linkedin", [linkedIn], "", assignmentsByPersona)).toBe(true);
    expect(launchChannelReady("linkedin", [linkedIn], personaId, assignmentsByPersona)).toBe(true);
    expect(launchChannelReady("instagram", [linkedIn], personaId, assignmentsByPersona)).toBe(false);
  });

  it("uses reddit test targets and feed targets for other channels", () => {
    expect(defaultTargetForChannel("reddit")).toBe("test");
    expect(defaultTargetForChannel("linkedin")).toBe("feed");
  });
});
