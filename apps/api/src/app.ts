import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
}

export async function buildApp({ db }: BuildAppOptions): Promise<TuezdayApp> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  app.get("/health", async () => {
    db.run(sql`select 1`);
    return { status: "ok", db: "ok" };
  });

  registerWorkspaceRoutes(app, db);

  return app;
}
