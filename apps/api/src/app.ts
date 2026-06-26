import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import { registerAuthGuard } from "./auth/guard";
import type { ConnectorFabric } from "./connectors/fabric";
import { NangoFabric } from "./connectors/nango";
import type { Db } from "./db";
import type { Fetcher } from "./discovery/adapters";
import { NullIntentProvider, type IntentProvider } from "./discovery/intent";
import { R2REvidenceStore } from "./evidence/r2r";
import type { EvidenceStore } from "./evidence/store";
import { GeminiGateway } from "./llm/gemini";
import type { LlmGateway } from "./llm/gateway";
import { CsvOutboundExporter, type OutboundExporter } from "./outbound/exporter";
import { createDefaultMailer, type Mailer } from "./mail/mailer";
import { registerAdCreativeRoutes } from "./routes/ad-creatives";
import { registerAdLaunchRoutes } from "./routes/ad-launches";
import { registerAdsRoutes } from "./routes/ads";
import { registerAudienceRoutes } from "./routes/audiences";
import { registerAuthRoutes } from "./routes/auth";
import { registerAutomationRoutes } from "./routes/automation";
import { registerBrainRoutes } from "./routes/brain";
import { registerCadenceRoutes } from "./routes/cadences";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerConnectorRoutes } from "./routes/connectors";
import { registerCrmRoutes } from "./routes/crm";
import { registerDiscoveryRoutes } from "./routes/discovery";
import { registerDraftRoutes } from "./routes/drafts";
import { registerEvidenceRoutes } from "./routes/evidence";
import { registerGuidanceRoutes } from "./routes/guidance";
import { registerGenerationSettingsRoutes } from "./routes/generation-settings";
import { registerInboxRoutes } from "./routes/inbox";
import { registerLaunchRoutes } from "./routes/launches";
import { registerLearningRoutes } from "./routes/learning";
import { registerMailRoutes } from "./routes/mail";
import { registerOutboundRoutes } from "./routes/outbound";
import { registerPrRoutes } from "./routes/pr";
import { registerPublicationRoutes } from "./routes/publications";
import { registerGenerationRoutes } from "./routes/generations";
import { registerPersonaRoutes } from "./routes/personas";
import { registerSignalRoutes } from "./routes/signals";
import { registerTeamRoutes } from "./routes/teams";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerOnboardingRoutes } from "./routes/onboarding";
import { registerInsightsRoutes } from "./routes/insights";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
  /** LLM gateway override; defaults to Gemini configured from env. */
  llm?: LlmGateway;
  /** HTTP fetcher for discovery adapters; tests inject fixtures. */
  fetcher?: Fetcher;
  /** Evidence store override; defaults to the R2R client from env. */
  evidence?: EvidenceStore;
  /** Connector fabric override; defaults to the Nango client from env. */
  connectors?: ConnectorFabric;
  /** Intent-signal provider (Sprint 31); defaults to the inert NullIntentProvider. */
  intent?: IntentProvider;
  /** Outbound-email exporter (Sprint 26); defaults to a Smartlead/Instantly CSV. */
  exporter?: OutboundExporter;
  /** Transactional mailer (Sprint 27); defaults to Resend, else a console logger. */
  mailer?: Mailer;
  /**
   * Shared secret that authenticates the worker as the `system` actor with
   * access to every workspace. Defaults to TUEZDAY_WORKER_TOKEN.
   */
  workerToken?: string;
}

export async function buildApp({
  db,
  llm = new GeminiGateway(),
  fetcher = fetch,
  evidence = new R2REvidenceStore(),
  connectors = new NangoFabric(undefined, undefined, fetcher),
  intent = new NullIntentProvider(),
  exporter = new CsvOutboundExporter(),
  mailer = createDefaultMailer(fetcher),
  workerToken = process.env.TUEZDAY_WORKER_TOKEN,
}: BuildAppOptions): Promise<TuezdayApp> {
  const app = Fastify({ logger: false });

  // @fastify/cors only allows GET/HEAD/POST by default — the brain editor
  // saves with PUT, and later slices use PATCH/DELETE.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Must come before any routes: every route registered after this needs a
  // session (or the worker token), except the guard's public allowlist.
  registerAuthGuard(app, db, workerToken);

  app.get("/health", async () => {
    db.run(sql`select 1`);
    return { status: "ok", db: "ok" };
  });

  registerAuthRoutes(app, db);
  registerWorkspaceRoutes(app, db);
  registerTeamRoutes(app, db, mailer);
  app.register(registerOnboardingRoutes(db));
  registerBrainRoutes(app, db);
  registerGuidanceRoutes(app, db);
  registerGenerationSettingsRoutes(app, db);
  registerPersonaRoutes(app, db, evidence);
  registerGenerationRoutes(app, db, llm, evidence);
  registerDraftRoutes(app, db, fetcher, llm);
  registerSignalRoutes(app, db, llm, evidence);
  registerDiscoveryRoutes(app, db, llm, fetcher, intent);
  registerCampaignRoutes(app, db);
  registerAudienceRoutes(app, db);
  registerEvidenceRoutes(app, db, evidence);
  registerLearningRoutes(app, db, llm, fetcher);
  registerOutboundRoutes(app, db, llm, evidence);
  registerLaunchRoutes(app, db, llm, evidence, connectors, fetcher, exporter);
  registerConnectorRoutes(app, db, connectors, fetcher);
  registerCrmRoutes(app, db, connectors, fetcher);
  registerAdsRoutes(app, db, connectors, fetcher);
  registerAdLaunchRoutes(app, db, connectors, fetcher);
  registerAdCreativeRoutes(app, db, llm, evidence);
  registerPrRoutes(app, db, llm, evidence);
  registerPublicationRoutes(app, db, connectors, fetcher);
  registerCadenceRoutes(app, db, connectors, fetcher);
  registerMailRoutes(app, db, mailer);
  registerAutomationRoutes(app, db, llm, evidence);
  registerInboxRoutes(app, db, llm, evidence, connectors, fetcher);
  registerInsightsRoutes(app, db);

  return app;
}
