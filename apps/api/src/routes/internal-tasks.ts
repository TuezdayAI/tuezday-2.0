import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import type { IntentProvider } from "../discovery/intent";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { DiscoveryOperatorPolicy } from "../runtime/operator-policy";
import type { SafeFetchService } from "../safe-fetch";
import { runAutomationWithLease } from "../services/automation";
import {
  runDiscoveryScheduler,
  type DiscoveryOperatorEvent,
} from "../services/discovery-scheduler";
import { runPipelinesTick } from "../services/pipeline-tick";
import { withTaskLease } from "../services/task-leases";
import { listWorkspaces } from "../services/workspaces";

export interface InternalTaskDependencies {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  policy: DiscoveryOperatorPolicy;
  instanceId: string;
  shutdownSignal: AbortSignal;
  log: (event: DiscoveryOperatorEvent) => void;
}

const EMPTY_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

export function registerInternalTaskRoutes(
  app: FastifyInstance,
  deps: InternalTaskDependencies,
): void {
  app.post(
    "/internal/discovery/tick",
    { schema: { body: EMPTY_BODY_SCHEMA } },
    async () =>
      runDiscoveryScheduler(
        {
          db: deps.db,
          llm: deps.llm,
          safeFetch: deps.safeFetch,
          intentProvider: deps.intentProvider,
          fabric: deps.fabric,
          policy: deps.policy,
          instanceId: deps.instanceId,
          shutdownSignal: deps.shutdownSignal,
          log: deps.log,
        },
        {},
      ),
  );

  app.post(
    "/internal/automation/tick",
    { schema: { body: EMPTY_BODY_SCHEMA } },
    async () => {
      const leased = await withTaskLease(
        deps.db,
        {
          key: "automation:scheduler",
          owner:
            `${deps.instanceId}:automation-scheduler:${randomUUID()}`,
          leaseMs: deps.policy.leaseMs,
          heartbeatMs: deps.policy.heartbeatMs,
        },
        async ({ signal }) => {
          let processed = 0;
          for (const workspace of listWorkspaces(deps.db)) {
            if (signal.aborted || deps.shutdownSignal.aborted) break;
            const result = await runAutomationWithLease(
              {
                db: deps.db,
                llm: deps.llm,
                evidence: deps.evidence,
                leaseMs: deps.policy.leaseMs,
                heartbeatMs: deps.policy.heartbeatMs,
              },
              workspace.id,
              `${deps.instanceId}:automation-workspace:${workspace.id}:${randomUUID()}`,
            );
            if (!result.busy) processed += 1;
          }
          return { processed };
        },
      );
      return leased.busy
        ? { busy: true, processed: 0 }
        : { busy: false, processed: leased.value.processed };
    },
  );

  // Sprint 65 (D-65.3): drive queued live/shadow pipeline runs to a resting
  // state. One global lease — executePipelineRun's own claim fence handles
  // any per-run race with a synchronous route execution.
  app.post(
    "/internal/pipelines/tick",
    { schema: { body: EMPTY_BODY_SCHEMA } },
    async () => {
      const leased = await withTaskLease(
        deps.db,
        {
          key: "pipelines:scheduler",
          owner: `${deps.instanceId}:pipelines-scheduler:${randomUUID()}`,
          leaseMs: deps.policy.leaseMs,
          heartbeatMs: deps.policy.heartbeatMs,
        },
        () =>
          runPipelinesTick(deps.db, {
            llm: deps.llm,
            evidence: deps.evidence,
            safeFetch: deps.safeFetch,
          }),
      );
      return leased.busy
        ? {
            busy: true,
            processed: 0,
            succeeded: 0,
            failed: 0,
            escalated: 0,
            blocked: 0,
            autoApproved: 0,
          }
        : { busy: false, ...leased.value };
    },
  );
}
