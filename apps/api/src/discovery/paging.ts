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

export function targetsForSource(
  source: DiscoverySource,
  trackedAccounts: ResolvedTrackedAccount[],
): DiscoveryTarget[] {
  const mode = modeFor(source);
  if (mode === "account_timeline") {
    const raw = [
      ...(source.config.handle ? [source.config.handle] : []),
      ...(source.config.handles ?? []),
      ...trackedAccounts.map((account) => account.handle),
    ];
    const seen = new Set<string>();
    const targets: DiscoveryTarget[] = [];
    for (const value of raw) {
      const handle = value.trim().replace(/^@+/, "");
      const normalized = handle.toLowerCase();
      if (!handle || seen.has(normalized)) continue;
      seen.add(normalized);
      const account = trackedAccounts.find(
        (candidate) =>
          candidate.handle.trim().replace(/^@+/, "").toLowerCase() ===
          normalized,
      );
      const key = `handle:${normalized}`;
      const externalId = account?.externalId ?? null;
      targets.push({
        key,
        handle,
        externalId,
        fingerprint: JSON.stringify({
          type: source.type,
          mode,
          key,
          externalId,
          config: source.config,
        }),
      });
    }
    if (targets.length > 0) return targets;
  }

  const key =
    mode === "hashtag" && source.config.hashtag
      ? `hashtag:${source.config.hashtag.trim().replace(/^#+/, "").toLowerCase()}`
      : "default";
  return [
    {
      key,
      fingerprint: JSON.stringify({
        type: source.type,
        mode,
        key,
        config: source.config,
      }),
    },
  ];
}

export function cursorMode(source: DiscoverySource): string {
  return modeFor(source);
}
