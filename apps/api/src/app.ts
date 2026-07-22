import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import { sql } from "drizzle-orm";
import type { AnalyticsSink } from "./analytics/sink";
import { createAnalyticsSink } from "./analytics/sink";
import { registerAuthGuard } from "./auth/guard";
import type { ConnectorFabric } from "./connectors/fabric";
import { NangoFabric } from "./connectors/nango";
import type { Db } from "./db";
import { OpenDesignProvider } from "./design/open-design";
import type { DesignProvider } from "./design/provider";
import { closeRenderer, renderSlide, type RenderInput } from "./design/render";
import { S3AssetStorage, type AssetStorage } from "./design/storage";
import type { Fetcher } from "./discovery/adapters";
import { NullIntentProvider, type IntentProvider } from "./discovery/intent";
import { DbEvidenceStore } from "./evidence/db-store";
import type { EvidenceStore } from "./evidence/store";
import { createLlmGatewayFromEnv } from "./llm";
import type { LlmGateway } from "./llm/gateway";
import { CsvOutboundExporter, type OutboundExporter } from "./outbound/exporter";
import { createOutboundEmailProviderFromEnv } from "./outbound-email/resend";
import { FabricGmailProvider, type GmailMailboxProvider } from "./outbound-email/gmail";
import type { OutboundEmailProvider } from "./outbound-email/provider";
import { createResendWebhookVerifierFromEnv, type ResendWebhookVerifier } from "./outbound-email/webhook";
import { createDefaultMailer, type Mailer } from "./mail/mailer";
import { registerAdCreativeRoutes } from "./routes/ad-creatives";
import { registerAdImageRoutes } from "./routes/ad-images";
import { registerAdLaunchRoutes } from "./routes/ad-launches";
import { registerAdsRoutes } from "./routes/ads";
import { registerAudienceRoutes } from "./routes/audiences";
import { registerAuthRoutes } from "./routes/auth";
import { registerAutomationRoutes } from "./routes/automation";
import { registerBrainRoutes } from "./routes/brain";
import { registerCadenceRoutes } from "./routes/cadences";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerCampaignPlanRoutes } from "./routes/campaign-plans";
import { registerCarouselRoutes } from "./routes/carousels";
import { registerConnectorRoutes } from "./routes/connectors";
import { registerContextMatrixRoutes } from "./routes/context-matrix";
import { registerCrmRoutes } from "./routes/crm";
import { registerDiscoveryRoutes } from "./routes/discovery";
import { registerDraftRoutes } from "./routes/drafts";
import { registerEvidenceRoutes } from "./routes/evidence";
import { registerExecutionRoutes } from "./routes/executions";
import { registerExternalActionRoutes } from "./routes/external-actions";
import { registerExternalActionBatchRoutes } from "./routes/external-action-batches";
import { registerExternalActionPolicyRoutes } from "./routes/external-action-policies";
import { registerEmailSenderRoutes } from "./routes/email-senders";
import { registerEmailRecipientSafetyRoutes } from "./routes/email-recipient-safety";
import { registerResendWebhookRoute } from "./routes/resend-webhooks";
import { registerDesignSystemRoutes } from "./routes/design-systems";
import { registerGuidanceRoutes } from "./routes/guidance";
import { registerGenerationSettingsRoutes } from "./routes/generation-settings";
import { registerInboxRoutes } from "./routes/inbox";
import { registerLaunchRoutes } from "./routes/launches";
import { registerLearningRoutes } from "./routes/learning";
import { registerMailRoutes } from "./routes/mail";
import { registerMailboxRoutes } from "./routes/mailboxes";
import { registerNextActionRoutes } from "./routes/next-action";
import { registerOutboundRoutes } from "./routes/outbound";
import { registerOutreachRoutes } from "./routes/outreach";
import { registerComplianceRoutes } from "./routes/compliance";
import { registerPrRoutes } from "./routes/pr";
import { registerPriorityRoutes } from "./routes/priorities";
import { registerPublicationRoutes } from "./routes/publications";
import { registerGenerationRoutes } from "./routes/generations";
import { registerPersonaRoutes } from "./routes/personas";
import { registerSignalRoutes } from "./routes/signals";
import { registerTeamRoutes } from "./routes/teams";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerBrandProfileRoutes } from "./routes/brand-profile";
import { registerSocialCorpusRoutes } from "./routes/social-corpus";
import { registerBrainAutoDraftRoutes } from "./routes/brain-autodraft";
import { registerInsightsRoutes } from "./routes/insights";
import { registerBillingRoutes, registerStripeWebhookRoute } from "./routes/billing";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerApiKeyRoutes } from "./routes/api-keys";
import { registerPublicApiRoutes } from "./routes/public-api";
import { backfillExternalActionPolicies } from "./services/external-action-backfill";
import { createExternalActionAdapters } from "./services/external-action-adapters";
import { createExternalActionRuntime } from "./services/external-action-coordinator";

export type TuezdayApp = FastifyInstance;

export interface BuildAppOptions {
  db: Db;
  /** LLM gateway override; defaults to Gemini configured from env. */
  llm?: LlmGateway;
  /** HTTP fetcher for discovery adapters; tests inject fixtures. */
  fetcher?: Fetcher;
  /** Evidence store override; defaults to the native SQLite store (Sprint 47). */
  evidence?: EvidenceStore;
  /** Connector fabric override; defaults to the Nango client from env. */
  connectors?: ConnectorFabric;
  /** Intent-signal provider (Sprint 31); defaults to the inert NullIntentProvider. */
  intent?: IntentProvider;
  /** Outbound-email exporter (Sprint 26); defaults to a Smartlead/Instantly CSV. */
  exporter?: OutboundExporter;
  /** Transactional mailer (Sprint 27); defaults to Resend, else a console logger. */
  mailer?: Mailer;
  /** Governed outbound-email provider; uses the platform Resend key when configured. */
  outboundEmail?: OutboundEmailProvider;
  /** Gmail mailbox provider (Sprint 47); defaults to the fabric-backed client. */
  gmail?: GmailMailboxProvider;
  /** Signature verifier for public Resend delivery webhooks. */
  resendWebhookVerifier?: ResendWebhookVerifier;
  /**
   * Shared secret that authenticates the worker as the `system` actor with
   * access to every workspace. Defaults to TUEZDAY_WORKER_TOKEN.
   */
  workerToken?: string;
  /** Product-analytics sink; defaults to PostHog-or-Noop from env. */
  analytics?: AnalyticsSink;
  /** Design template author (Sprint 41); defaults to the self-hosted Open Design client. */
  design?: DesignProvider;
  /** Public asset storage (Sprint 41); defaults to the S3-compatible client from env. */
  assetStorage?: AssetStorage;
  /** Slide renderer (Sprint 41); defaults to the Playwright renderer — tests inject a fake. */
  render?: (input: RenderInput) => Promise<Uint8Array>;
}

export async function buildApp({
  db,
  llm = createLlmGatewayFromEnv(),
  fetcher = fetch,
  evidence = new DbEvidenceStore(db, llm),
  connectors = new NangoFabric(undefined, undefined, fetcher),
  intent = new NullIntentProvider(),
  exporter = new CsvOutboundExporter(),
  mailer = createDefaultMailer(fetcher),
  outboundEmail = createOutboundEmailProviderFromEnv(fetcher),
  gmail = new FabricGmailProvider(connectors),
  resendWebhookVerifier = createResendWebhookVerifierFromEnv(),
  workerToken = process.env.TUEZDAY_WORKER_TOKEN,
  analytics = createAnalyticsSink(),
  design = new OpenDesignProvider(),
  assetStorage = new S3AssetStorage(),
  render = renderSlide,
}: BuildAppOptions): Promise<TuezdayApp> {
  // Signed public tokens can carry a normalized email address (up to 320
  // characters) plus an HMAC. Keep a hard router bound above that envelope.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1_024 } });
  backfillExternalActionPolicies(db);
  const externalActionRuntime = createExternalActionRuntime({
    db,
    adapters: createExternalActionAdapters(db, connectors, fetcher, outboundEmail, gmail),
    analytics,
  });

  // The design renderer keeps one shared headless browser per process.
  app.addHook("onClose", async () => {
    await closeRenderer();
  });

  // @fastify/cors only allows GET/HEAD/POST by default — the brain editor
  // saves with PUT, and later slices use PATCH/DELETE.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false, // only populated for routes that ask for it
    encoding: "utf8",
  });

  // Must come before any routes: every route registered after this needs a
  // session (or the worker token), except the guard's public allowlist.
  registerAuthGuard(app, db, workerToken);

  registerPublicApiRoutes(app, db);

  app.get("/health", async () => {
    db.run(sql`select 1`);
    return { status: "ok", db: "ok" };
  });

  registerAuthRoutes(app, db, fetcher, analytics);
  registerWorkspaceRoutes(app, db, llm, fetcher);
  registerBrandProfileRoutes(app, db, llm, fetcher);
  registerSocialCorpusRoutes(app, db, connectors);
  registerBrainAutoDraftRoutes(app, db, llm, connectors);
  registerApiKeyRoutes(app, db);
  registerTeamRoutes(app, db, mailer);
  registerBillingRoutes(app, db);
  registerStripeWebhookRoute(app, db);
  registerBrainRoutes(app, db, llm);
  registerGuidanceRoutes(app, db);
  registerDesignSystemRoutes(app, db);
  registerContextMatrixRoutes(app, db);
  registerGenerationSettingsRoutes(app, db);
  registerPersonaRoutes(app, db, evidence);
  registerGenerationRoutes(app, db, llm, evidence, analytics);
  registerDraftRoutes(app, db, fetcher, llm, analytics, mailer, evidence);
  registerCarouselRoutes(app, db, design, assetStorage, render);
  registerNotificationRoutes(app, db, mailer, fetcher);
  registerSignalRoutes(app, db, llm, evidence);
  registerDiscoveryRoutes(app, db, llm, fetcher, intent, connectors);
  registerCampaignRoutes(app, db);
  registerCampaignPlanRoutes(app, db);
  registerAudienceRoutes(app, db);
  registerEvidenceRoutes(app, db, evidence);
  registerLearningRoutes(app, db, llm, fetcher);
  registerOutboundRoutes(app, db, llm, evidence, externalActionRuntime);
  registerOutreachRoutes(app, db, llm, evidence, externalActionRuntime, connectors, mailer, fetcher);
  registerComplianceRoutes(app, db);
  registerLaunchRoutes(app, db, llm, evidence, exporter, externalActionRuntime);
  registerConnectorRoutes(app, db, connectors, fetcher, analytics);
  registerCrmRoutes(app, db, connectors, fetcher);
  registerAdsRoutes(app, db, connectors, fetcher);
  registerAdLaunchRoutes(app, db, connectors, fetcher, externalActionRuntime);
  registerAdCreativeRoutes(app, db, llm, evidence);
  registerAdImageRoutes(app, db, design, assetStorage, render);
  registerPrRoutes(app, db, llm, evidence, externalActionRuntime);
  registerPublicationRoutes(app, db, connectors, fetcher, analytics, externalActionRuntime);
  registerExecutionRoutes(app, db);
  registerExternalActionRoutes(app, db, externalActionRuntime);
  registerExternalActionBatchRoutes(app, db, externalActionRuntime);
  registerExternalActionPolicyRoutes(app, db);
  registerPriorityRoutes(app, db);
  registerCadenceRoutes(app, db, externalActionRuntime);
  registerMailRoutes(app, db, mailer);
  registerEmailSenderRoutes(app, db, outboundEmail);
  registerMailboxRoutes(app, db, llm, gmail);
  registerEmailRecipientSafetyRoutes(app, db);
  registerResendWebhookRoute(app, db, resendWebhookVerifier);
  registerAutomationRoutes(app, db, llm, evidence);
  registerInboxRoutes(app, db, llm, evidence, connectors, externalActionRuntime);
  registerInsightsRoutes(app, db);
  registerNextActionRoutes(app, db);

  return app;
}
