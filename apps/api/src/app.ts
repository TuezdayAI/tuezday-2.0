import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import { sql } from "drizzle-orm";
import type { AnalyticsSink } from "./analytics/sink";
import { createAnalyticsSink } from "./analytics/sink";
import { registerAuthGuard } from "./auth/guard";
import { EntitlementError } from "./services/entitlements";
import type { ConnectorFabric } from "./connectors/fabric";
import { NangoFabric } from "./connectors/nango";
import { assertProviderConfiguration } from "./connectors/provider-config";
import type { Db } from "./db";
import { OpenDesignProvider } from "./design/open-design";
import type { DesignProvider } from "./design/provider";
import { createRendererClient, type RenderInput } from "./design/render";
import { S3AssetStorage, type AssetStorage } from "./design/storage";
import { NullIntentProvider, type IntentProvider } from "./discovery/intent";
import { DbEvidenceStore } from "./evidence/db-store";
import type { EvidenceStore } from "./evidence/store";
import type { TrustedFetcher } from "./http";
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
import { registerAgentRunRoutes } from "./routes/agent-runs";
import { registerAudienceRoutes } from "./routes/audiences";
import { registerAuthRoutes } from "./routes/auth";
import { registerAutomationRoutes } from "./routes/automation";
import { registerBrainRoutes } from "./routes/brain";
import { registerCadenceRoutes } from "./routes/cadences";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerChatRoutes } from "./routes/chat";
import { registerCampaignPlanRoutes } from "./routes/campaign-plans";
import { registerCarouselRoutes } from "./routes/carousels";
import { registerConnectorRoutes } from "./routes/connectors";
import { registerContextMatrixRoutes } from "./routes/context-matrix";
import { registerCrmRoutes } from "./routes/crm";
import { registerDiscoveryRoutes } from "./routes/discovery";
import { registerStoryRoutes } from "./routes/stories";
import { registerOpportunityRoutes } from "./routes/opportunities";
import { registerPackageRoutes } from "./routes/packages";
import { registerDeliverableRoutes } from "./routes/deliverables";
import { registerPipelineRoutes } from "./routes/pipelines";
import { registerDraftRoutes } from "./routes/drafts";
import { registerEvalRoutes } from "./routes/evals";
import { registerPreferenceRoutes } from "./routes/preferences";
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
import { registerInternalBackgroundJobRoutes } from "./routes/internal-background-jobs";
import { registerLaunchRoutes } from "./routes/launches";
import { registerLearningRoutes } from "./routes/learning";
import { registerMailRoutes } from "./routes/mail";
import { registerMailboxRoutes } from "./routes/mailboxes";
import { registerNextActionRoutes } from "./routes/next-action";
import { registerOutboundRoutes } from "./routes/outbound";
import { registerOutreachRoutes } from "./routes/outreach";
import { registerComplianceRoutes } from "./routes/compliance";
import { registerTrackingRoutes } from "./routes/tracking";
import { registerPrRoutes } from "./routes/pr";
import { registerPriorityRoutes } from "./routes/priorities";
import { registerQuestionRoutes } from "./routes/questions";
import { registerTraceRoutes } from "./routes/trace";
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
import { backfillMissingCampaignPlans } from "./services/campaign-plan-backfill";
import { backfillMetrics } from "./services/metrics-backfill";
import { backfillExternalActionPolicies } from "./services/external-action-backfill";
import { createAgentProposals } from "./services/agent-proposals";
import { createAgentQuestions } from "./services/agent-questions";
import { createExternalActionAdapters } from "./services/external-action-adapters";
import { createExternalActionRuntime } from "./services/external-action-coordinator";
import { repairDanglingDuplicateGroups } from "./services/discovery-dedupe";
import type { DiscoveryOperatorEvent } from "./services/discovery-scheduler";
import { resolveCorsOrigin } from "./runtime/cors-origin";
import {
  createBackgroundJobHandlers,
  type BackgroundJobHandlers,
} from "./services/background-job-handlers";
import {
  parseBackgroundJobPolicy,
  type BackgroundJobPolicy,
} from "./runtime/background-job-policy";
import {
  DEFAULT_DISCOVERY_POLICY,
  type DiscoveryOperatorPolicy,
} from "./runtime/operator-policy";
import {
  createSafeFetchPolicy,
  createSafeFetchService,
  type SafeFetchService,
} from "./safe-fetch";

export type TuezdayApp = FastifyInstance;

function logDiscoveryOperatorEvent(event: DiscoveryOperatorEvent): void {
  if (process.env.NODE_ENV === "test") return;
  console.info(JSON.stringify({ event: "discovery_operator", ...event }));
}

export interface BuildAppOptions {
  db: Db;
  /** LLM gateway override; defaults to Gemini configured from env. */
  llm?: LlmGateway;
  /** Raw HTTP seam retained for trusted providers, connectors, and events. */
  fetcher?: TrustedFetcher;
  /** Guarded outbound fetcher for discovery and website scraping. */
  safeFetch?: SafeFetchService;
  /** Evidence store override; defaults to the native SQLite store (Sprint 47). */
  evidence?: EvidenceStore;
  /** Connector fabric override; defaults to the Nango client from env. */
  connectors?: ConnectorFabric;
  /** Intent-signal provider (Sprint 31); defaults to the inert NullIntentProvider. */
  intent?: IntentProvider;
  /**
   * Manual data-export format for approved outbound email (Sprint 26; reframed
   * in Sprint 51). This is an export affordance only — it is never a send path
   * and never a routing choice. Native email delivery owns sending (governed
   * `send` external actions from a verified workspace sender); this exporter
   * exists solely so a founder can download their own approved copy.
   */
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
  /** Typed durable-job registry; defaults to fail-closed retry handlers. */
  backgroundJobHandlers?: BackgroundJobHandlers;
  /** Validated durable queue, lease, retry, and schedule policy. */
  backgroundJobPolicy?: BackgroundJobPolicy;
  /** Product-analytics sink; defaults to PostHog-or-Noop from env. */
  analytics?: AnalyticsSink;
  /** Design template author (Sprint 41); defaults to the self-hosted Open Design client. */
  design?: DesignProvider;
  /** Public asset storage (Sprint 41); defaults to the S3-compatible client from env. */
  assetStorage?: AssetStorage;
  /** Slide renderer (Sprint 75); defaults to the isolated renderer client — tests inject a fake. */
  render?: (input: RenderInput) => Promise<Uint8Array>;
  /** Validated deployment-only discovery budgets. */
  operatorPolicy?: DiscoveryOperatorPolicy;
  /** Stable API process identity used as the prefix for lease owners. */
  instanceId?: string;
  /** Safe structured discovery runtime event sink. */
  operatorLog?: (event: DiscoveryOperatorEvent) => void;
  /** Process shutdown signal; tests may inject one directly. */
  shutdownSignal?: AbortSignal;
  /** Allowed browser origins; defaults from WEB_ORIGIN, `true` reflects any origin (dev). */
  corsOrigin?: true | string[];
}

export async function buildApp({
  db,
  llm = createLlmGatewayFromEnv(),
  fetcher = fetch,
  safeFetch,
  evidence = new DbEvidenceStore(db, llm),
  connectors = new NangoFabric(undefined, undefined, fetcher),
  intent = new NullIntentProvider(),
  exporter = new CsvOutboundExporter(),
  mailer = createDefaultMailer(fetcher),
  outboundEmail = createOutboundEmailProviderFromEnv(fetcher),
  gmail = new FabricGmailProvider(connectors),
  resendWebhookVerifier = createResendWebhookVerifierFromEnv(),
  workerToken = process.env.TUEZDAY_WORKER_TOKEN,
  backgroundJobHandlers,
  backgroundJobPolicy = parseBackgroundJobPolicy(process.env),
  analytics = createAnalyticsSink(),
  design = new OpenDesignProvider(),
  assetStorage = new S3AssetStorage(),
  render = createRendererClient(),
  operatorPolicy = DEFAULT_DISCOVERY_POLICY,
  instanceId = `${process.env.HOSTNAME?.trim() || hostname()}:${randomUUID()}`,
  operatorLog = logDiscoveryOperatorEvent,
  shutdownSignal,
  corsOrigin = resolveCorsOrigin(),
}: BuildAppOptions): Promise<TuezdayApp> {
  assertProviderConfiguration();
  const guardedFetch =
    safeFetch ?? createSafeFetchService(createSafeFetchPolicy());
  // Signed public tokens can carry a normalized email address (up to 320
  // characters) plus an HMAC; click-tracking tokens (Sprint 50) embed the whole
  // redirect URL inside the signed payload. Keep the bound above that envelope.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 4_096 } });
  const ownedShutdown = shutdownSignal ? undefined : new AbortController();
  const effectiveShutdownSignal =
    shutdownSignal ?? ownedShutdown!.signal;
  await backfillExternalActionPolicies(db);
  // Sprint 53: every campaign must own a plan revision before Task 4 removes
  // the legacy structured block from the campaign overlay. Idempotent — only
  // campaigns with no revision at all are candidates.
  const campaignPlanBackfill = await backfillMissingCampaignPlans(db);
  if (campaignPlanBackfill.failed.length > 0) {
    // The sweep never retries a failure — its candidate predicate is "no plan
    // revision at all", and a failed activation leaves the draft behind. So a
    // campaign that lands here stays on the legacy structured fallback until a
    // human finishes its plan, and this line is the only notice anyone gets.
    app.log.warn(
      {
        failed: campaignPlanBackfill.failed,
        scanned: campaignPlanBackfill.scanned,
        planned: campaignPlanBackfill.planned,
      },
      `campaign plan backfill: ${campaignPlanBackfill.failed.length} campaign(s) kept a draft-only plan and still resolve with the legacy strategy fallback`,
    );
  }
  await repairDanglingDuplicateGroups(db);
  // Sprint 55: sweep the three legacy metric stores into the unified fact
  // table. Runs after the dual-write shipped, so it is insert-if-absent and
  // can never overwrite a fresher dual-written value with a staler legacy one.
  await backfillMetrics(db);
  const externalActionRuntime = createExternalActionRuntime({
    db,
    adapters: createExternalActionAdapters(db, connectors, fetcher, outboundEmail, gmail),
    analytics,
  });
  // Sprint 69: the propose seam. Built once here, where the runtime already
  // exists, and injected into the engine — the agent tools themselves stay
  // leaves and never import any of this (D-69.5).
  const agentProposals = createAgentProposals({
    db,
    runtime: externalActionRuntime,
    fabric: connectors,
    fetcher,
  });
  // Sprint 70: the ask seam, built once for the same reason.
  const agentQuestions = createAgentQuestions({ db });
  const effectiveBackgroundJobHandlers =
    backgroundJobHandlers ??
    createBackgroundJobHandlers({
      db,
      llm,
      evidence,
      safeFetch: guardedFetch,
      proposals: agentProposals,
      questions: agentQuestions,
      intentProvider: intent,
      fabric: connectors,
      gmail,
      mailer,
      fetcher,
      runtime: externalActionRuntime,
      discoveryPolicy: operatorPolicy,
      jobPolicy: backgroundJobPolicy,
      instanceId,
      log: operatorLog,
    });

  app.addHook("preClose", async () => {
    ownedShutdown?.abort(new Error("app_shutdown"));
  });
  app.addHook("onClose", async () => {
    ownedShutdown?.abort(new Error("app_shutdown"));
  });

  // @fastify/cors only allows GET/HEAD/POST by default — the brain editor
  // saves with PUT, and later slices use PATCH/DELETE. origin defaults to
  // WEB_ORIGIN's allowlist (see resolveCorsOrigin); unset, it reflects any
  // origin, matching this app's behavior before the allowlist existed.
  await app.register(cors, {
    origin: corsOrigin,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false, // only populated for routes that ask for it
    encoding: "utf8",
  });

  // Plan-limit convention (Sprint 59): an uncaught EntitlementError anywhere
  // is the standard 402 upgrade_required shape, so new budget gates need no
  // per-route catch. Existing per-route catches stay and win where present.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EntitlementError) {
      return reply.status(402).send({ error: "upgrade_required", key: error.key, limit: error.limit });
    }
    throw error; // fall through to Fastify's default handling
  });

  // Must come before any routes: every route registered after this needs a
  // session (or the worker token), except the guard's public allowlist.
  registerAuthGuard(app, db, workerToken);

  registerPublicApiRoutes(app, db);

  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok", db: "ok" };
  });

  registerInternalBackgroundJobRoutes(app, {
    db,
    handlers: effectiveBackgroundJobHandlers,
    policy: backgroundJobPolicy,
    instanceId,
    shutdownSignal: effectiveShutdownSignal,
  });

  registerAuthRoutes(app, db, fetcher, analytics);
  registerWorkspaceRoutes(app, db, llm, guardedFetch);
  registerBrandProfileRoutes(app, db, llm, guardedFetch);
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
  registerChatRoutes(app, db, llm, evidence, guardedFetch, agentProposals);
  registerAgentRunRoutes(app, db, { llm, evidence, safeFetch: guardedFetch });
  registerDiscoveryRoutes(
    app,
    db,
    llm,
    guardedFetch,
    fetcher,
    intent,
    connectors,
    {
      policy: operatorPolicy,
      instanceId,
      shutdownSignal: effectiveShutdownSignal,
      log: operatorLog,
    },
  );
  registerStoryRoutes(app, db);
  registerOpportunityRoutes(app, db, llm);
  registerPackageRoutes(app, db, llm);
  registerDeliverableRoutes(app, db, llm);
  registerPipelineRoutes(app, db, {
    llm,
    evidence,
    safeFetch: guardedFetch,
    proposals: agentProposals,
    questions: agentQuestions,
  });
  registerQuestionRoutes(app, db, {
    engine: {
      llm,
      evidence,
      safeFetch: guardedFetch,
      proposals: agentProposals,
      questions: agentQuestions,
    },
  });
  registerTraceRoutes(app, db);
  registerEvalRoutes(app, db, { llm, evidence, safeFetch: guardedFetch });
  registerPreferenceRoutes(app, db, { llm });
  registerCampaignRoutes(app, db);
  registerCampaignPlanRoutes(app, db);
  registerAudienceRoutes(app, db);
  registerEvidenceRoutes(app, db, evidence);
  registerLearningRoutes(app, db, llm, fetcher);
  registerOutboundRoutes(app, db, llm, evidence, externalActionRuntime);
  registerOutreachRoutes(app, db, llm, evidence, externalActionRuntime, connectors, mailer, fetcher);
  registerComplianceRoutes(app, db);
  registerTrackingRoutes(app, db);
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
  registerAutomationRoutes(app, db, llm, evidence, instanceId);
  registerInboxRoutes(app, db, llm, evidence, connectors, externalActionRuntime);
  registerInsightsRoutes(app, db);
  registerNextActionRoutes(app, db);

  return app;
}
