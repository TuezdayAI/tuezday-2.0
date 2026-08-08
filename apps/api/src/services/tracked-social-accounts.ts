import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type {
  CreateTrackedSocialAccountInput,
  TrackedSocialAccount,
  TrackedSocialPlatform,
  UpdateTrackedSocialAccountInput,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  discoveryJobs,
  discoverySources,
  trackedSocialAccounts,
  type TrackedSocialAccountRow,
} from "../db/schema";

// Tracked social accounts (Sprint 46): competitor/source accounts a workspace
// listens to. Connected discovery sources reference them by id via
// config.trackedAccountId(s) instead of re-typing handles per source.

export class DuplicateTrackedAccountError extends Error {
  constructor(platform: string, handle: string) {
    super(`"${handle}" on ${platform} is already tracked in this workspace.`);
    this.name = "DuplicateTrackedAccountError";
  }
}

export class InvalidTrackedHandleError extends Error {
  constructor(handle: string) {
    super(`"${handle}" is not a usable account handle.`);
    this.name = "InvalidTrackedHandleError";
  }
}

export class DiscoveryReferenceNotFoundError extends Error {
  constructor() {
    super("related_object_not_found");
    this.name = "DiscoveryReferenceNotFoundError";
  }
}

/**
 * Canonical handle form per platform, so "@Competitor" and "competitor" land
 * on the same row: X/Instagram strip the leading @ and lowercase (handles are
 * case-insensitive there); Reddit strips a leading r/ or u/ and lowercases;
 * LinkedIn keeps the value as entered (vanity slugs and URNs are opaque).
 */
export function normalizeTrackedHandle(platform: TrackedSocialPlatform, handle: string): string {
  const trimmed = handle.trim();
  switch (platform) {
    case "x":
    case "instagram":
      return trimmed.replace(/^@+/, "").toLowerCase();
    case "reddit":
      return trimmed.replace(/^\/?(r|u)\//i, "").toLowerCase();
    case "linkedin":
      return trimmed;
  }
}

function rowToAccount(row: TrackedSocialAccountRow): TrackedSocialAccount {
  return { ...row, platform: row.platform as TrackedSocialPlatform };
}

async function findByHandle(
  db: Db,
  workspaceId: string,
  platform: string,
  handle: string,
): Promise<TrackedSocialAccountRow | undefined> {
  return (await db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.platform, platform),
        eq(trackedSocialAccounts.handle, handle),
      ),
    ))[0];
}

function trackedAccountIds(configJson: string): string[] {
  try {
    const config = JSON.parse(configJson) as {
      trackedAccountId?: unknown;
      trackedAccountIds?: unknown;
    };
    return [
      ...(typeof config.trackedAccountId === "string"
        ? [config.trackedAccountId]
        : []),
      ...(Array.isArray(config.trackedAccountIds)
        ? config.trackedAccountIds.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ];
  } catch {
    return [];
  }
}

async function invalidateSourcesForTrackedAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const affectedSourceIds = (await db
    .select({
      id: discoverySources.id,
      configJson: discoverySources.configJson,
    })
    .from(discoverySources)
    .where(eq(discoverySources.workspaceId, workspaceId)))
    .filter((source) =>
      trackedAccountIds(source.configJson).includes(accountId),
    )
    .map((source) => source.id);
  if (affectedSourceIds.length === 0) return;

  await db.update(discoverySources)
    .set({
      executionVersion: sql`
        ${discoverySources.executionVersion} + 1
      `,
    })
    .where(
      and(
        eq(discoverySources.workspaceId, workspaceId),
        inArray(discoverySources.id, affectedSourceIds),
      ),
    );
  await db.update(discoveryJobs)
    .set({
      status: "skipped",
      finishedAt: Date.now(),
      error: "source_version_changed",
      lockedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    })
    .where(
      and(
        eq(discoveryJobs.workspaceId, workspaceId),
        inArray(discoveryJobs.sourceId, affectedSourceIds),
        inArray(discoveryJobs.status, ["queued", "running"]),
      ),
    );
}

export async function createTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  input: CreateTrackedSocialAccountInput,
): Promise<TrackedSocialAccount> {
  const handle = normalizeTrackedHandle(input.platform, input.handle);
  if (!handle) throw new InvalidTrackedHandleError(input.handle);
  if (await findByHandle(db, workspaceId, input.platform, handle)) {
    throw new DuplicateTrackedAccountError(input.platform, handle);
  }
  const now = Date.now();
  const row: TrackedSocialAccountRow = {
    id: randomUUID(),
    workspaceId,
    platform: input.platform,
    handle,
    displayName: input.displayName ?? null,
    externalId: null,
    url: input.url ?? null,
    notes: input.notes ?? "",
    enabled: true,
    lastResolvedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(trackedSocialAccounts).values(row);
  return rowToAccount(row);
}

export async function listTrackedSocialAccounts(db: Db, workspaceId: string): Promise<TrackedSocialAccount[]> {
  return (await db
    .select()
    .from(trackedSocialAccounts)
    .where(eq(trackedSocialAccounts.workspaceId, workspaceId))
    .orderBy(desc(trackedSocialAccounts.createdAt)))
    .map(rowToAccount);
}

export async function getTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): Promise<TrackedSocialAccount | undefined> {
  const row = (await db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.id, accountId),
      ),
    ))[0];
  return row ? rowToAccount(row) : undefined;
}

export async function updateTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
  input: UpdateTrackedSocialAccountInput,
): Promise<TrackedSocialAccount | undefined> {
  const existing = await getTrackedSocialAccount(db, workspaceId, accountId);
  if (!existing) return undefined;

  let handle = existing.handle;
  if (input.handle !== undefined) {
    handle = normalizeTrackedHandle(existing.platform, input.handle);
    if (!handle) throw new InvalidTrackedHandleError(input.handle);
    const clash = (await db
      .select({ id: trackedSocialAccounts.id })
      .from(trackedSocialAccounts)
      .where(
        and(
          eq(trackedSocialAccounts.workspaceId, workspaceId),
          eq(trackedSocialAccounts.platform, existing.platform),
          eq(trackedSocialAccounts.handle, handle),
          ne(trackedSocialAccounts.id, accountId),
        ),
      ))[0];
    if (clash) throw new DuplicateTrackedAccountError(existing.platform, handle);
  }

  const nextEnabled = input.enabled ?? existing.enabled;
  const handleChanged = handle !== existing.handle;
  const executionChanged =
    handleChanged || nextEnabled !== existing.enabled;
  return await db.transaction(async (tx) => {
    await tx.update(trackedSocialAccounts)
      .set({
        handle,
        displayName:
          input.displayName === undefined
            ? existing.displayName
            : input.displayName,
        externalId: handleChanged ? null : existing.externalId,
        lastResolvedAt: handleChanged
          ? null
          : existing.lastResolvedAt,
        lastError: handleChanged ? null : existing.lastError,
        url: input.url === undefined ? existing.url : input.url,
        notes: input.notes ?? existing.notes,
        enabled: nextEnabled,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(trackedSocialAccounts.workspaceId, workspaceId),
          eq(trackedSocialAccounts.id, accountId),
        ),
      );
    if (executionChanged) {
      await invalidateSourcesForTrackedAccount(
        tx as unknown as Db,
        workspaceId,
        accountId,
      );
    }
    return await getTrackedSocialAccount(
      tx as unknown as Db,
      workspaceId,
      accountId,
    );
  });
}

export async function deleteTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): Promise<boolean> {
  if (!await getTrackedSocialAccount(db, workspaceId, accountId)) return false;
  await db.transaction(async (tx) => {
    await invalidateSourcesForTrackedAccount(
      tx as unknown as Db,
      workspaceId,
      accountId,
    );
    await tx
      .delete(trackedSocialAccounts)
      .where(
        and(
          eq(trackedSocialAccounts.workspaceId, workspaceId),
          eq(trackedSocialAccounts.id, accountId),
        ),
      );
  });
  return true;
}

/**
 * The enabled tracked accounts a source config references — what a connected
 * discovery fetch actually listens to. Unknown/deleted ids are dropped.
 */
export async function resolveTrackedAccounts(
  db: DbExecutor,
  workspaceId: string,
  ids: string[],
): Promise<TrackedSocialAccount[]> {
  if (ids.length === 0) return [];
  return (await db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.enabled, true),
        inArray(trackedSocialAccounts.id, ids),
      ),
    ))
    .map(rowToAccount);
}

/**
 * Resolve every requested enabled account inside one workspace. Missing,
 * disabled, and foreign ids are deliberately indistinguishable.
 */
export async function requireTrackedAccounts(
  db: DbExecutor,
  workspaceId: string,
  ids: readonly string[],
): Promise<TrackedSocialAccount[]> {
  const uniqueIds = [...new Set(ids)];
  const accounts = await resolveTrackedAccounts(db, workspaceId, uniqueIds);
  if (accounts.length !== uniqueIds.length) {
    throw new DiscoveryReferenceNotFoundError();
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return uniqueIds.map((id) => accountById.get(id)!);
}
