import { describe, expect, it } from "vitest";
import type { Launch, LaunchDetail } from "@tuezday/contracts";
import {
  mergeLaunchAdmission,
  shouldPollLaunchGeneration,
} from "./launch-generation-view";

const launch = (id: string, status: Launch["status"]): Launch => ({
  id,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  name: `Launch ${id}`,
  audienceId: "22222222-2222-4222-8222-222222222222",
  campaignId: null,
  personaId: null,
  channels: ["email"],
  status,
  automationMode: "manual",
  stopOnReply: true,
  xConnectionId: null,
  messageCount: 0,
  createdAt: 1,
  updatedAt: 1,
});

const detail = (row: Launch): LaunchDetail => ({
  launch: row,
  messages: [],
  steps: [],
  sequenceRecipients: [],
  recipientCount: 0,
});

describe("launch generation view state", () => {
  it("shows an admitted generating launch immediately", () => {
    const draft = launch("launch-a", "draft");
    const generating = { ...draft, status: "generating" as const, updatedAt: 2 };

    expect(mergeLaunchAdmission([draft], generating)).toEqual([generating]);
  });

  it("polls only the open generating launch and stops at a terminal status", () => {
    expect(shouldPollLaunchGeneration("launch-a", detail(launch("launch-a", "generating")))).toBe(true);
    expect(shouldPollLaunchGeneration("launch-b", detail(launch("launch-a", "generating")))).toBe(false);
    expect(shouldPollLaunchGeneration("launch-a", detail(launch("launch-a", "ready")))).toBe(false);
    expect(shouldPollLaunchGeneration("launch-a", null)).toBe(false);
  });
});
