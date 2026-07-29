import { createHash } from "node:crypto";
import type { DiscoverySource } from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import type { SafeFetchService } from "../safe-fetch";
import type { IntentProvider } from "./intent";
import type { RawDiscoveredItem } from "./adapters";
import type { ResolvedTrackedAccount } from "./connected-adapters";

export interface DiscoveryTargetCheckpoint {
  targetFingerprint: string;
  highWatermark: {
    externalId: string;
    publishedAt: number | null;
  } | null;
  continuation: {
    providerToken: string | null;
    boundaryExternalId: string | null;
    newestExternalId: string | null;
    newestPublishedAt: number | null;
  } | null;
  lastSafeError: string | null;
}

export interface DiscoveryCursorV1 {
  version: 1;
  mode: string;
  nextTargetIndex: number;
  targets: Record<string, DiscoveryTargetCheckpoint>;
}

export interface DiscoveryTarget {
  key: string;
  fingerprint: string;
  handle?: string;
  externalId?: string | null;
}

export interface DiscoveryPage {
  targetKey: string;
  items: RawDiscoveredItem[];
  nextToken: string | null;
  reachedBoundary: boolean;
  exhausted: boolean;
  callsUsed: number;
  decodedBytes: number;
}

export interface DiscoveryPageReadInput {
  db: Db;
  source: DiscoverySource;
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  signal: AbortSignal;
  maxItems: number;
  maxCalls: number;
  maxResponseBytes: number;
  maxBytes: number;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  trackedAccounts: ResolvedTrackedAccount[];
}

export type DiscoveryPageReader = (
  input: DiscoveryPageReadInput,
) => Promise<DiscoveryPage>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0)
  );
}

function parseCheckpoint(
  value: unknown,
): DiscoveryTargetCheckpoint | undefined {
  if (!isRecord(value) || typeof value.targetFingerprint !== "string") {
    return undefined;
  }

  let highWatermark: DiscoveryTargetCheckpoint["highWatermark"] = null;
  if (value.highWatermark !== null) {
    if (
      !isRecord(value.highWatermark) ||
      typeof value.highWatermark.externalId !== "string" ||
      !nullableTimestamp(value.highWatermark.publishedAt)
    ) {
      return undefined;
    }
    highWatermark = {
      externalId: value.highWatermark.externalId,
      publishedAt: value.highWatermark.publishedAt,
    };
  }

  let continuation: DiscoveryTargetCheckpoint["continuation"] = null;
  if (value.continuation !== null) {
    if (
      !isRecord(value.continuation) ||
      !nullableString(value.continuation.providerToken) ||
      !nullableString(value.continuation.boundaryExternalId) ||
      !nullableString(value.continuation.newestExternalId) ||
      !nullableTimestamp(value.continuation.newestPublishedAt)
    ) {
      return undefined;
    }
    continuation = {
      providerToken: value.continuation.providerToken,
      boundaryExternalId: value.continuation.boundaryExternalId,
      newestExternalId: value.continuation.newestExternalId,
      newestPublishedAt: value.continuation.newestPublishedAt,
    };
  }

  if (!nullableString(value.lastSafeError)) return undefined;
  return {
    targetFingerprint: value.targetFingerprint,
    highWatermark,
    continuation,
    lastSafeError: value.lastSafeError,
  };
}

function emptyCursor(mode: string): DiscoveryCursorV1 {
  return {
    version: 1,
    mode,
    nextTargetIndex: 0,
    targets: {},
  };
}

export function readCursor(raw: string, mode: string): DiscoveryCursorV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCursor(mode);
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.mode !== mode ||
    !Number.isSafeInteger(parsed.nextTargetIndex) ||
    (parsed.nextTargetIndex as number) < 0 ||
    !isRecord(parsed.targets)
  ) {
    return emptyCursor(mode);
  }

  const targets: Record<string, DiscoveryTargetCheckpoint> = {};
  for (const [key, value] of Object.entries(parsed.targets)) {
    const checkpoint = parseCheckpoint(value);
    if (checkpoint) targets[key] = checkpoint;
  }
  return {
    version: 1,
    mode,
    nextTargetIndex: parsed.nextTargetIndex as number,
    targets,
  };
}

export function emptyTargetCheckpoint(
  fingerprint: string,
): DiscoveryTargetCheckpoint {
  return {
    targetFingerprint: fingerprint,
    highWatermark: null,
    continuation: null,
    lastSafeError: null,
  };
}

export function reconcileTargets(
  cursor: DiscoveryCursorV1,
  targets: DiscoveryTarget[],
): DiscoveryCursorV1 {
  const reconciled: Record<string, DiscoveryTargetCheckpoint> = {};
  for (const target of targets) {
    const existing = cursor.targets[target.key];
    reconciled[target.key] =
      existing?.targetFingerprint === target.fingerprint
        ? existing
        : emptyTargetCheckpoint(target.fingerprint);
  }
  return {
    version: 1,
    mode: cursor.mode,
    nextTargetIndex:
      targets.length === 0 ? 0 : cursor.nextTargetIndex % targets.length,
    targets: reconciled,
  };
}

export function safeCursorProgress(
  cursor: DiscoveryCursorV1,
  checkpointAt: number | null,
): {
  version: 1;
  targetCount: number;
  backlog: boolean;
  lastCheckpointAt: number | null;
} {
  return {
    version: 1,
    targetCount: Object.keys(cursor.targets).length,
    backlog: Object.values(cursor.targets).some(
      (checkpoint) => checkpoint.continuation !== null,
    ),
    lastCheckpointAt: checkpointAt,
  };
}

function modeFor(source: DiscoverySource): string {
  return source.config.mode?.trim() || source.type;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function normalizedConfig(source: DiscoverySource): string {
  return JSON.stringify(stableValue(source.config));
}

function normalizedHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function resolveDiscoveryTargets(input: {
  source: DiscoverySource;
  trackedAccounts: ResolvedTrackedAccount[];
}): DiscoveryTarget[] {
  const { source, trackedAccounts } = input;
  const mode = modeFor(source);
  if (mode === "account_timeline") {
    const seen = new Set<string>();
    const targets: DiscoveryTarget[] = [];
    for (const account of trackedAccounts) {
      const normalized = normalizedHandle(account.handle);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const key = `tracked:${account.id}`;
      targets.push({
        key,
        handle: normalized,
        externalId: account.externalId,
        fingerprint: sha256(
          JSON.stringify({
            provider: source.type,
            mode,
            id: account.id,
            handle: normalized,
            externalId: account.externalId,
            enabled: account.enabled,
            updatedAt: account.updatedAt,
          }),
        ),
      });
    }
    const inline = [
      ...(source.config.handle ? [source.config.handle] : []),
      ...(source.config.handles ?? []),
    ];
    for (const value of inline) {
      const normalized = normalizedHandle(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const key = sha256(`${source.type}|${mode}|${normalized}`);
      targets.push({
        key,
        handle: normalized,
        externalId: null,
        fingerprint: sha256(
          JSON.stringify({
            provider: source.type,
            mode,
            target: normalized,
            config: stableValue(source.config),
          }),
        ),
      });
    }
    if (targets.length > 0) return targets;
  }

  const targetValue =
    mode === "hashtag"
      ? source.config.hashtag?.trim().replace(/^#+/, "").toLowerCase()
      : mode === "query"
        ? source.config.query?.trim().replace(/\s+/g, " ").toLowerCase()
        : mode === "list_timeline"
          ? source.config.listId?.trim()
          : undefined;
  const normalized = targetValue || normalizedConfig(source);
  const key = sha256(
    `${source.type}|${mode}|${normalized}`,
  );
  return [
    {
      key,
      fingerprint: sha256(
        JSON.stringify({
          provider: source.type,
          mode,
          target: normalized,
          config: stableValue(source.config),
        }),
      ),
    },
  ];
}

/** Backwards-compatible internal name while callers migrate. */
export function targetsForSource(
  source: DiscoverySource,
  trackedAccounts: ResolvedTrackedAccount[],
): DiscoveryTarget[] {
  return resolveDiscoveryTargets({ source, trackedAccounts });
}

function newestItem(items: RawDiscoveredItem[]) {
  return [...items].sort((left, right) => {
    const byDate = (right.publishedAt ?? -1) - (left.publishedAt ?? -1);
    return byDate || right.externalId.localeCompare(left.externalId);
  })[0];
}

export function checkpointPage(input: {
  cursor: DiscoveryCursorV1;
  target: DiscoveryTarget;
  page: DiscoveryPage;
  nextTargetIndex: number;
}): DiscoveryCursorV1 {
  const prior =
    input.cursor.targets[input.target.key] ??
    emptyTargetCheckpoint(input.target.fingerprint);
  const newest = newestItem(input.page.items);
  const capturedNewest = prior.continuation?.newestExternalId
    ? {
        externalId: prior.continuation.newestExternalId,
        publishedAt: prior.continuation.newestPublishedAt,
      }
    : newest
      ? {
          externalId: newest.externalId,
          publishedAt: newest.publishedAt,
        }
      : null;
  const boundaryExternalId =
    prior.continuation?.boundaryExternalId ??
    prior.highWatermark?.externalId ??
    null;
  const complete =
    input.page.reachedBoundary || input.page.exhausted;
  const checkpoint: DiscoveryTargetCheckpoint = {
    targetFingerprint: input.target.fingerprint,
    highWatermark:
      complete && capturedNewest
        ? capturedNewest
        : prior.highWatermark,
    continuation: complete
      ? null
      : {
          providerToken: input.page.nextToken,
          boundaryExternalId,
          newestExternalId: capturedNewest?.externalId ?? null,
          newestPublishedAt: capturedNewest?.publishedAt ?? null,
        },
    lastSafeError: null,
  };
  return {
    ...input.cursor,
    nextTargetIndex: input.nextTargetIndex,
    targets: {
      ...input.cursor.targets,
      [input.target.key]: checkpoint,
    },
  };
}

export function cursorMode(source: DiscoverySource): string {
  return modeFor(source);
}
