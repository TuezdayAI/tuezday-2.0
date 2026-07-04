import type { Channel, Connection } from "@tuezday/contracts";
import type { ResolveAccount } from "@tuezday/brain";
import type { Db } from "../db";
import { getConnection } from "./connections";
import {
  providerForSocialChannel,
  resolvePersonaSocialConnection,
} from "./persona-social-accounts";

/**
 * The publishing account a draft will go out from, as resolver input
 * (Sprint 44). Uses the exact routing publishing uses (primary account for
 * persona × provider × channel), so what the model sees at draft time is the
 * account the post lands on. Returns undefined whenever the account can't be
 * determined or has an empty content profile — drafting must never fail (or
 * grow noise sections) because account routing didn't resolve.
 */
export function resolveDraftAccount(
  db: Db,
  workspaceId: string,
  args: {
    personaId?: string | null;
    channel: Channel;
    /** Explicit connection — engagement replies know theirs from the inbox item. */
    connectionId?: string;
  },
): ResolveAccount | undefined {
  let connection: Connection | undefined;

  if (args.connectionId) {
    connection = getConnection(db, workspaceId, args.connectionId);
  } else {
    if (!args.personaId || !providerForSocialChannel(args.channel)) return undefined;
    const resolution = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: args.personaId,
      channel: args.channel,
    });
    if (!resolution.ok) return undefined;
    connection = resolution.connection;
  }
  if (!connection) return undefined;

  const profile = connection.contentProfile;
  if (profile.topics.length === 0 && !profile.guidance.trim()) return undefined;

  return {
    name: connection.externalAccountName || connection.displayName,
    handle: connection.externalAccountHandle,
    provider: connection.providerKey,
    topics: profile.topics,
    guidance: profile.guidance,
  };
}
