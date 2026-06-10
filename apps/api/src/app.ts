import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { registerBrainRoutes } from "./routes/brain";
import { registerPersonaRoutes } from "./routes/personas";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
}

export async function buildApp({ db }: BuildAppOptions): Promise<TuezdayApp> {
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

  return app;
}
