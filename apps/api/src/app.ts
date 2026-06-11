import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { GeminiGateway } from "./llm/gemini";
import type { LlmGateway } from "./llm/gateway";
import { registerBrainRoutes } from "./routes/brain";
import { registerDraftRoutes } from "./routes/drafts";
import { registerGenerationRoutes } from "./routes/generations";
import { registerPersonaRoutes } from "./routes/personas";
import { registerSignalRoutes } from "./routes/signals";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
  /** LLM gateway override; defaults to Gemini configured from env. */
  llm?: LlmGateway;
}

export async function buildApp({ db, llm = new GeminiGateway() }: BuildAppOptions): Promise<TuezdayApp> {
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
  registerPersonaRoutes(app, db);
  registerGenerationRoutes(app, db, llm);
  registerDraftRoutes(app, db);
  registerSignalRoutes(app, db, llm);

  return app;
}
