import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BrandProfile, SocialCorpus } from "@tuezday/contracts";
import { BRAIN_DOC_TYPES } from "@tuezday/contracts";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import type { Db } from "../src/db";
import { brandProfiles, connections } from "../src/db/schema";
import { draftBrain, runBrainAutoDraft } from "../src/services/brain-autodraft";
import { getBrain, updateBrainDoc } from "../src/services/brain";
import { createWorkspace } from "../src/services/workspaces";
import { registerAccount } from "../src/services/auth";
import { createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE: BrandProfile = {
  businessName: "Hexalog",
  tagline: "Logs, but hexagonal",
  summary: "Hexalog packs structured logs into hexagonal storage for observability teams.",
  targetAgeRange: "25-45",
  tone: "Dry, technical, quietly funny.",
  voiceDimensions: {
    purpose: "Help engineers trust their logs",
    audience: "Platform and SRE teams",
    tone: "Dry and precise",
    emotions: "Calm confidence",
    character: "A senior engineer who has seen things",
    syntax: "Short declarative sentences",
    language: "US English, technical",
  },
  pillars: ["Honest observability", "Hexagonal storage"],
  sourceNotes: "",
};

const EMPTY_SOCIAL: SocialCorpus = { connected: [], entries: [], corpus: "" };

const SOCIAL_WITH_POSTS: SocialCorpus = {
  connected: ["twitter"],
  entries: [
    {
      provider: "twitter",
      profile: {
        provider: "twitter",
        handle: "hexalog",
        displayName: "Hexalog",
        bio: "Logs, but hexagonal",
        recentPosts: [{ text: "We shipped hex packing!", url: "", createdAt: null }],
      },
      error: null,
    },
  ],
  corpus: "# twitter @hexalog\nHexalog\nLogs, but hexagonal\nRecent posts:\n- We shipped hex packing!",
};

/** Stub gateway that echoes the doc title found in the prompt; records prompts. */
function markerLlm(opts?: { throwWhenPromptContains?: string }): {
  llm: LlmGateway;
  calls: () => number;
  prompts: string[];
} {
  let n = 0;
  const prompts: string[] = [];
  return {
    llm: {
      async generate({ prompt }) {
        n += 1;
        prompts.push(prompt);
        if (opts?.throwWhenPromptContains && prompt.includes(opts.throwWhenPromptContains)) {
          throw new GatewayError("provider_error", "stub gateway failure");
        }
        const title = prompt.match(/"([^"]+)" brain document/)?.[1] ?? "unknown";
        return {
          text: `  Drafted ${title} doc grounded in the material.  `,
          model: "stub",
          provider: "stub",
          durationMs: 1,
        };
      },
    },
    calls: () => n,
    prompts,
  };
}

/** A fabric whose proxyJson 404s everything — fine here: no social connections are seeded. */
function fakeFabric(): ConnectorFabric {
  const unused = async (): Promise<never> => {
    throw new Error("unused in this test");
  };
  return {
    health: async () => ({ healthy: true }),
    ensureIntegration: async () => {},
    createConnectSession: unused,
    importConnection: async () => {},
    connectionExists: async () => true,
    deleteConnection: async () => {},
    proxyGet: unused,
    async proxyJson(_method, path): Promise<ProxyJsonResult> {
      return { status: 404, json: { message: `no fixture for ${path}` } };
    },
  };
}

function seedReadyProfile(db: Db, workspaceId: string): void {
  db.insert(brandProfiles)
    .values({
      id: randomUUID(),
      workspaceId,
      sourceUrl: "https://x.co",
      status: "ready",
      profileJson: JSON.stringify(PROFILE),
      error: null,
      corpusChars: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

function setup() {
  const db = createTestDb();
  const { user } = registerAccount(db, {
    email: `bad-${randomUUID()}@test.dev`,
    password: "test-password-1",
    name: "BAD",
  });
  const ws = createWorkspace(db, { name: "AutoDraft WS" }, user.id);
  return { db, ws };
}

// ---------------------------------------------------------------------------
// draftBrain (no DB)
// ---------------------------------------------------------------------------

describe("draftBrain", () => {
  it("drafts all five docs with one generate call each", async () => {
    const { llm, calls, prompts } = markerLlm();
    const result = await draftBrain(llm, { profile: PROFILE, socialCorpus: SOCIAL_WITH_POSTS });

    expect(result.insufficient).toBe(false);
    expect(calls()).toBe(5);
    for (const docType of BRAIN_DOC_TYPES) {
      expect(result.drafts[docType]).toBeTruthy();
      expect(result.drafts[docType]!.trim()).toBe(result.drafts[docType]); // trimmed
    }
    // Prompts carry the profile + social material.
    for (const prompt of prompts) {
      expect(prompt).toContain("Hexalog");
      expect(prompt).toContain("We shipped hex packing!");
    }
  });

  it("isolates a per-doc gateway failure: voice absent, other four drafted", async () => {
    const { llm, calls } = markerLlm({ throwWhenPromptContains: '"Voice"' });
    const result = await draftBrain(llm, { profile: PROFILE, socialCorpus: EMPTY_SOCIAL });

    expect(calls()).toBe(5);
    expect(result.insufficient).toBe(false);
    expect(result.drafts.voice).toBeUndefined();
    expect(Object.keys(result.drafts).sort()).toEqual(["history", "icp", "now", "soul"]);
  });

  it("returns insufficient with zero LLM calls when profile null and corpus empty", async () => {
    const { llm, calls } = markerLlm();
    const result = await draftBrain(llm, {
      profile: null,
      socialCorpus: { connected: [], entries: [], corpus: "   \n  " },
    });

    expect(result).toEqual({ drafts: {}, insufficient: true });
    expect(calls()).toBe(0);
  });

  it("drafts from social corpus alone when profile is null", async () => {
    const { llm, calls } = markerLlm();
    const result = await draftBrain(llm, { profile: null, socialCorpus: SOCIAL_WITH_POSTS });

    expect(result.insufficient).toBe(false);
    expect(calls()).toBe(5);
    expect(Object.keys(result.drafts)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// runBrainAutoDraft (real test db)
// ---------------------------------------------------------------------------

describe("runBrainAutoDraft", () => {
  it("drafts all five docs for an empty brain with a ready profile", async () => {
    const { db, ws } = setup();
    seedReadyProfile(db, ws.id);

    const view = await runBrainAutoDraft(db, markerLlm().llm, fakeFabric(), ws.id);

    expect(view.insufficient).toBe(false);
    expect(view.drafted.sort()).toEqual([...BRAIN_DOC_TYPES].sort());
    expect(view.skipped).toEqual([]);
    const brain = getBrain(db, ws.id);
    for (const doc of brain.docs) {
      expect(doc.content.trim().length).toBeGreaterThan(0);
    }
    expect(view.brain.completeness.percent).toBeGreaterThan(0);
  });

  it("never clobbers a pre-edited doc: soul skipped and unchanged", async () => {
    const { db, ws } = setup();
    seedReadyProfile(db, ws.id);
    const handWritten = "My hand-written soul doc content here with enough words";
    updateBrainDoc(db, ws.id, "soul", handWritten);

    const view = await runBrainAutoDraft(db, markerLlm().llm, fakeFabric(), ws.id);

    expect(view.insufficient).toBe(false);
    expect(view.skipped).toEqual(["soul"]);
    expect(view.drafted.sort()).toEqual(["history", "icp", "now", "voice"]);
    const soul = getBrain(db, ws.id).docs.find((d) => d.docType === "soul")!;
    expect(soul.content).toBe(handWritten);
  });

  it("returns insufficient and writes nothing with no profile and no social", async () => {
    const { db, ws } = setup();
    const { llm, calls } = markerLlm();

    const view = await runBrainAutoDraft(db, llm, fakeFabric(), ws.id);

    expect(view.insufficient).toBe(true);
    expect(view.drafted).toEqual([]);
    expect(view.skipped).toEqual([]);
    expect(calls()).toBe(0);
    for (const doc of view.brain.docs) {
      expect(doc.content).toBe("");
    }
    expect(view.brain.completeness.percent).toBe(0);
  });

  it("degrades to an empty social corpus when the social read throws", async () => {
    const { db, ws } = setup();
    seedReadyProfile(db, ws.id);
    // A connected social account makes readSocialCorpus actually touch the
    // fabric; the exploding proxy then throws out of the read itself.
    db.insert(connections)
      .values({
        id: randomUUID(),
        workspaceId: ws.id,
        providerKey: "twitter",
        nangoConnectionId: `ws-${ws.id}-twitter`,
        configJson: "{}",
        status: "connected",
        lastCheckedAt: Date.now(),
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const explodingFabric = new Proxy(fakeFabric(), {
      get() {
        throw new Error("fabric exploded");
      },
    }) as ConnectorFabric;

    const view = await runBrainAutoDraft(db, markerLlm().llm, explodingFabric, ws.id);

    expect(view.insufficient).toBe(false);
    expect(view.drafted.sort()).toEqual([...BRAIN_DOC_TYPES].sort());
  });
});
