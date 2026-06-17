import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  CHANNELS,
  CHANNEL_GUIDANCE_DEFAULTS,
  type Channel,
  type ChannelGuidance,
  type GuidanceSource,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { guidanceOverrides } from "../db/schema";

export interface ResolvedGuidance {
  content: string;
  source: GuidanceSource;
  updatedAt: number | null;
}

/**
 * The channel guidance in effect for a workspace: the workspace override if one
 * exists, otherwise the built-in default. Used by the resolver call sites and
 * by the editor read endpoints.
 */
export function resolveChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
): ResolvedGuidance {
  const row = db
    .select()
    .from(guidanceOverrides)
    .where(
      and(eq(guidanceOverrides.workspaceId, workspaceId), eq(guidanceOverrides.channel, channel)),
    )
    .get();
  if (row) {
    return { content: row.content, source: "workspace", updatedAt: row.updatedAt };
  }
  return { content: CHANNEL_GUIDANCE_DEFAULTS[channel], source: "default", updatedAt: null };
}

/** Every channel's resolved guidance — always six rows, defaults included. */
export function listChannelGuidance(db: Db, workspaceId: string): ChannelGuidance[] {
  return CHANNELS.map((channel) => {
    const resolved = resolveChannelGuidance(db, workspaceId, channel);
    return { channel, content: resolved.content, source: resolved.source, updatedAt: resolved.updatedAt };
  });
}

/** Create or update the override for one channel; returns the resolved row. */
export function setChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
  content: string,
): ChannelGuidance {
  const now = Date.now();
  const existing = db
    .select({ id: guidanceOverrides.id })
    .from(guidanceOverrides)
    .where(
      and(eq(guidanceOverrides.workspaceId, workspaceId), eq(guidanceOverrides.channel, channel)),
    )
    .get();

  if (existing) {
    db.update(guidanceOverrides)
      .set({ content, updatedAt: now })
      .where(eq(guidanceOverrides.id, existing.id))
      .run();
  } else {
    db.insert(guidanceOverrides)
      .values({ id: randomUUID(), workspaceId, channel, content, createdAt: now, updatedAt: now })
      .run();
  }

  return { channel, content, source: "workspace", updatedAt: now };
}

/** Delete the override for one channel; returns the now-default guidance. */
export function resetChannelGuidance(
  db: Db,
  workspaceId: string,
  channel: Channel,
): ChannelGuidance {
  db.delete(guidanceOverrides)
    .where(
      and(eq(guidanceOverrides.workspaceId, workspaceId), eq(guidanceOverrides.channel, channel)),
    )
    .run();
  const resolved = resolveChannelGuidance(db, workspaceId, channel);
  return { channel, content: resolved.content, source: resolved.source, updatedAt: resolved.updatedAt };
}

/** Narrow an arbitrary string to a Channel, or undefined. */
export function asChannel(value: string): Channel | undefined {
  return (CHANNELS as readonly string[]).includes(value) ? (value as Channel) : undefined;
}
