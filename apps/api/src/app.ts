import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import type { Fetcher } from "./discovery/adapters";
import { R2REvidenceStore } from "./evidence/r2r";
import type { EvidenceStore } from "./evidence/store";
import { GeminiGateway } from "./llm/gemini";
import type { LlmGateway } from "./llm/gateway";
import { registerBrainRoutes } from "./routes/brain";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerDiscoveryRoutes } from "./routes/discovery";
import { registerDraftRoutes } from "./routes/drafts";
import { registerEvidenceRoutes } from "./routes/evidence";
import { registerLearningRoutes } from "./routes/learning";
import { registerOutboundRoutes } from "./routes/outbound";
import { registerGenerationRoutes } from "./routes/generations";
import { registerPersonaRoutes } from "./routes/personas";
import { registerSignalRoutes } from "./routes/signals";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
  /** LLM gateway override; defaults to Gemini configured from env. */
  llm?: LlmGateway;
  /** HTTP fetcher for discovery adapters; tests inject fixtures. */
  fetcher?: Fetcher;
  /** Evidence store override; defaults to the R2R client from env. */
  evidence?: EvidenceStore;
}

export async function buildApp({
  db,
  llm = new GeminiGateway(),
  fetcher = fetch,
  evidence = new R2REvidenceStore(),
}: BuildAppOptions): Promise<TuezdayApp> {
  const app = Fastify({ logger: false });

  // @fastify/cors only allows GET/HEAD/POST by default — the brain editor
  // saves with PUT, and later slices use PATCH/DELETE.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.get("/health", async () => {
    db.run(sql`select 1`);
    return { status: "ok", db: "ok" };
  });

  registerWorkspaceRoutes(app, db);
  registerBrainRoutes(app, db);
  registerPersonaRoutes(app, db, evidence);
  registerGenerationRoutes(app, db, llm, evidence);
  registerDraftRoutes(app, db);
  registerSignalRoutes(app, db, llm, evidence);
  registerDiscoveryRoutes(app, db, llm, fetcher);
  registerCampaignRoutes(app, db);
  registerEvidenceRoutes(app, db, evidence);
  registerLearningRoutes(app, db, llm);
  registerOutboundRoutes(app, db, llm, evidence);

  return app;
}
