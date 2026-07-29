import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type {
  CreateTrackedSocialAccountInput,
  TrackedSocialAccount,
  TrackedSocialPlatform,
  UpdateTrackedSocialAccountInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
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

function findByHandle(
  db: Db,
  workspaceId: string,
  platform: string,
  handle: string,
): TrackedSocialAccountRow | undefined {
  return db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.platform, platform),
        eq(trackedSocialAccounts.handle, handle),
      ),
    )
    .get();
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

function invalidateSourcesForTrackedAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): void {
  const affectedSourceIds = db
    .select({
      id: discoverySources.id,
      configJson: discoverySources.configJson,
    })
    .from(discoverySources)
    .where(eq(discoverySources.workspaceId, workspaceId))
    .all()
    .filter((source) =>
      trackedAccountIds(source.configJson).includes(accountId),
    )
    .map((source) => source.id);
  if (affectedSourceIds.length === 0) return;

  db.update(discoverySources)
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
    )
    .run();
  db.update(discoveryJobs)
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
    )
    .run();
}

export function createTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  input: CreateTrackedSocialAccountInput,
): TrackedSocialAccount {
  const handle = normalizeTrackedHandle(input.platform, input.handle);
  if (!handle) throw new InvalidTrackedHandleError(input.handle);
  if (findByHandle(db, workspaceId, input.platform, handle)) {
    throw new DuplicateTrackedAccountError(input.platform, handle);
  }
  const now = Date.now();
  const row: TrackedSocialAccountRow = {
    id: randomUUID(),
    workspaceId,
    platform: input.platform,
    handle,
    displayName: input.displayName ?? null,
    externalId: input.externalId ?? null,
    url: input.url ?? null,
    notes: input.notes ?? "",
    enabled: true,
    lastResolvedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(trackedSocialAccounts).values(row).run();
  return rowToAccount(row);
}

export function listTrackedSocialAccounts(db: Db, workspaceId: string): TrackedSocialAccount[] {
  return db
    .select()
    .from(trackedSocialAccounts)
    .where(eq(trackedSocialAccounts.workspaceId, workspaceId))
    .orderBy(desc(trackedSocialAccounts.createdAt))
    .all()
    .map(rowToAccount);
}

export function getTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): TrackedSocialAccount | undefined {
  const row = db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.id, accountId),
      ),
    )
    .get();
  return row ? rowToAccount(row) : undefined;
}

export function updateTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
  input: UpdateTrackedSocialAccountInput,
): TrackedSocialAccount | undefined {
  const existing = getTrackedSocialAccount(db, workspaceId, accountId);
  if (!existing) return undefined;

  let handle = existing.handle;
  if (input.handle !== undefined) {
    handle = normalizeTrackedHandle(existing.platform, input.handle);
    if (!handle) throw new InvalidTrackedHandleError(input.handle);
    const clash = db
      .select({ id: trackedSocialAccounts.id })
      .from(trackedSocialAccounts)
      .where(
        and(
          eq(trackedSocialAccounts.workspaceId, workspaceId),
          eq(trackedSocialAccounts.platform, existing.platform),
          eq(trackedSocialAccounts.handle, handle),
          ne(trackedSocialAccounts.id, accountId),
        ),
      )
      .get();
    if (clash) throw new DuplicateTrackedAccountError(existing.platform, handle);
  }

  const nextExternalId =
    input.externalId === undefined ? existing.externalId : input.externalId;
  const nextEnabled = input.enabled ?? existing.enabled;
  const executionChanged =
    handle !== existing.handle ||
    nextExternalId !== existing.externalId ||
    nextEnabled !== existing.enabled;
  return db.transaction((tx) => {
    tx.update(trackedSocialAccounts)
      .set({
        handle,
        displayName:
          input.displayName === undefined
            ? existing.displayName
            : input.displayName,
        externalId: nextExternalId,
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
      )
      .run();
    if (executionChanged) {
      invalidateSourcesForTrackedAccount(
        tx as unknown as Db,
        workspaceId,
        accountId,
      );
    }
    return getTrackedSocialAccount(
      tx as unknown as Db,
      workspaceId,
      accountId,
    );
  });
}

export function deleteTrackedSocialAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): boolean {
  if (!getTrackedSocialAccount(db, workspaceId, accountId)) return false;
  db.transaction((tx) => {
    invalidateSourcesForTrackedAccount(
      tx as unknown as Db,
      workspaceId,
      accountId,
    );
    tx
      .delete(trackedSocialAccounts)
      .where(
        and(
          eq(trackedSocialAccounts.workspaceId, workspaceId),
          eq(trackedSocialAccounts.id, accountId),
        ),
      )
      .run();
  });
  return true;
}

/**
 * The enabled tracked accounts a source config references — what a connected
 * discovery fetch actually listens to. Unknown/deleted ids are dropped.
 */
export function resolveTrackedAccounts(
  db: Db,
  workspaceId: string,
  ids: string[],
): TrackedSocialAccount[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(trackedSocialAccounts)
    .where(
      and(
        eq(trackedSocialAccounts.workspaceId, workspaceId),
        eq(trackedSocialAccounts.enabled, true),
        inArray(trackedSocialAccounts.id, ids),
      ),
    )
    .all()
    .map(rowToAccount);
}

/**
 * Resolve every requested enabled account inside one workspace. Missing,
 * disabled, and foreign ids are deliberately indistinguishable.
 */
export function requireTrackedAccounts(
  db: Db,
  workspaceId: string,
  ids: readonly string[],
): TrackedSocialAccount[] {
  const uniqueIds = [...new Set(ids)];
  const accounts = resolveTrackedAccounts(db, workspaceId, uniqueIds);
  if (accounts.length !== uniqueIds.length) {
    throw new DiscoveryReferenceNotFoundError();
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return uniqueIds.map((id) => accountById.get(id)!);
}
