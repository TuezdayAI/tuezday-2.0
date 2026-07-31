import type {
  Connection,
  DiscoverySource,
  TrackedSocialAccount,
} from "@tuezday/contracts";
import { and, eq } from "drizzle-orm";
import type { ConnectorFabric } from "../connectors/fabric";
import { linkedinRestHeaders } from "../connectors/provider-config";
import type { Db } from "../db";
import {
  ConnectedDiscoveryBudgetError,
} from "../discovery/connected-adapters";
import {
  resolveLinkedInOrganizationUrn,
  resolveXUserId,
} from "../discovery/provider-account-resolvers";
import { ProviderCapabilityError } from "../discovery/provider-errors";
import { trackedSocialAccounts } from "../db/schema";
import { getConnection } from "./connections";
import { getTrackedSocialAccount } from "./tracked-social-accounts";

export interface TrackedResolutionRuntime {
  signal?: AbortSignal;
  maxCalls?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
  metrics: { calls: number; bytes: number };
}

const PLATFORM_PROVIDER = {
  x: "twitter",
  linkedin: "linkedin",
  instagram: "instagram",
  reddit: "reddit",
} as const;

const PROVIDER_BASE_URL = {
  twitter: "https://api.twitter.com",
  linkedin: "https://api.linkedin.com",
} as const;

export class TrackedAccountConnectionError extends Error {
  readonly code = "connection_unavailable";

  constructor() {
    super("A compatible connected account is unavailable.");
    this.name = "TrackedAccountConnectionError";
  }
}

export class TrackedAccountNotFoundError extends Error {
  constructor() {
    super("Tracked account not found.");
    this.name = "TrackedAccountNotFoundError";
  }
}

export interface TrackedAccountResolverDependencies {
  db: Db;
  fabric: ConnectorFabric;
}

async function providerGet(
  deps: TrackedAccountResolverDependencies,
  connection: Connection,
  path: string,
  baseUrl: string,
  runtime?: TrackedResolutionRuntime,
): Promise<{ status: number; json: unknown }> {
  if (
    runtime?.maxCalls !== undefined &&
    runtime.metrics.calls >= runtime.maxCalls
  ) {
    throw new ConnectedDiscoveryBudgetError("call_budget_exhausted");
  }
  if (runtime) runtime.metrics.calls += 1;
  const response = await deps.fabric.proxyJson(
    "GET",
    path,
    connection.nangoConnectionId,
    `tuezday-${connection.providerKey}`,
    {
      baseUrlOverride: baseUrl,
      headers:
        connection.providerKey === "linkedin"
          ? linkedinRestHeaders()
          : undefined,
      signal: runtime?.signal,
      maxResponseBytes: runtime?.maxResponseBytes,
    },
  );
  if (runtime) {
    runtime.metrics.bytes += response.decodedBytes ?? 0;
    if (
      runtime.maxBytes !== undefined &&
      runtime.metrics.bytes > runtime.maxBytes
    ) {
      throw new ConnectedDiscoveryBudgetError(
        "source_byte_budget_exhausted",
      );
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderCapabilityError(
      "permission_required",
      "The selected connection lacks permission to resolve this account.",
    );
  }
  return { status: response.status, json: response.json };
}

function persistResolutionSuccess(
  db: Db,
  account: TrackedSocialAccount,
  externalId: string,
): TrackedSocialAccount {
  const now = Date.now();
  db.update(trackedSocialAccounts)
    .set({
      externalId,
      lastResolvedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, account.workspaceId),
        eq(trackedSocialAccounts.id, account.id),
      ),
    )
    .run();
  return getTrackedSocialAccount(
    db,
    account.workspaceId,
    account.id,
  )!;
}

function persistResolutionFailure(
  db: Db,
  account: TrackedSocialAccount,
  error: ProviderCapabilityError,
): void {
  db.update(trackedSocialAccounts)
    .set({
      lastError: `${error.code}: ${error.message}`.slice(0, 500),
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, account.workspaceId),
        eq(trackedSocialAccounts.id, account.id),
      ),
    )
    .run();
}

export async function resolveTrackedSocialAccount(
  deps: TrackedAccountResolverDependencies,
  input: {
    workspaceId: string;
    accountId: string;
    connectionId: string;
    force?: boolean;
    runtime?: TrackedResolutionRuntime;
  },
): Promise<TrackedSocialAccount> {
  const account = getTrackedSocialAccount(
    deps.db,
    input.workspaceId,
    input.accountId,
  );
  if (!account) throw new TrackedAccountNotFoundError();
  if (!account.enabled) throw new TrackedAccountConnectionError();

  const connection = getConnection(
    deps.db,
    input.workspaceId,
    input.connectionId,
  );
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.providerKey !== PLATFORM_PROVIDER[account.platform]
  ) {
    throw new TrackedAccountConnectionError();
  }
  if (input.force !== true && account.externalId) return account;

  try {
    let externalId: string;
    if (account.platform === "x") {
      externalId = await resolveXUserId({
        handle: account.handle,
        get: (path) =>
          providerGet(
            deps,
            connection,
            path,
            PROVIDER_BASE_URL.twitter,
            input.runtime,
          ),
      });
    } else if (account.platform === "linkedin") {
      externalId = await resolveLinkedInOrganizationUrn({
        target: account.handle,
        get: (path) =>
          providerGet(
            deps,
            connection,
            path,
            PROVIDER_BASE_URL.linkedin,
            input.runtime,
          ),
      });
    } else if (account.platform === "reddit") {
      externalId = account.handle;
    } else {
      if (
        connection.config.authArchitecture !== "instagram_login"
      ) {
        throw new ProviderCapabilityError(
          "reconnect_required",
          "Reconnect Instagram with direct Instagram Login.",
        );
      }
      const requested = account.handle
        .replace(/^@+/, "")
        .toLowerCase();
      const connected = connection.externalAccountHandle
        ?.replace(/^@+/, "")
        .toLowerCase();
      if (!connected || !connection.externalAccountId) {
        throw new ProviderCapabilityError(
          "reconnect_required",
          "Reconnect Instagram to bind its professional account.",
        );
      }
      if (requested !== connected) {
        throw new ProviderCapabilityError(
          "unsupported_target",
          "Instagram Login can resolve only its connected account.",
        );
      }
      externalId = connection.externalAccountId;
    }
    return persistResolutionSuccess(deps.db, account, externalId);
  } catch (error) {
    if (error instanceof ProviderCapabilityError) {
      persistResolutionFailure(deps.db, account, error);
    }
    throw error;
  }
}

export async function resolveTrackedAccountsForSource(
  deps: TrackedAccountResolverDependencies,
  input: {
    source: DiscoverySource;
    accounts: TrackedSocialAccount[];
    connectionId: string;
    runtime: TrackedResolutionRuntime;
  },
): Promise<TrackedSocialAccount[]> {
  const resolved: TrackedSocialAccount[] = [];
  for (const account of input.accounts) {
    resolved.push(
      await resolveTrackedSocialAccount(deps, {
        workspaceId: input.source.workspaceId,
        accountId: account.id,
        connectionId: input.connectionId,
        force: false,
        runtime: input.runtime,
      }),
    );
  }
  return resolved;
}
