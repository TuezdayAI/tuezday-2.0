import type {
  Connection,
  LaunchChannel,
  PersonaSocialAccount,
  SocialAccountChannel,
} from "@tuezday/contracts";

const SOCIAL_CHANNEL_PROVIDER: Record<SocialAccountChannel, string> = {
  linkedin: "linkedin",
  instagram: "instagram",
  x: "twitter",
  reddit: "reddit",
};

export function providerForPersonaSocialChannel(channel: string): string | null {
  return SOCIAL_CHANNEL_PROVIDER[channel as SocialAccountChannel] ?? null;
}

export function defaultTargetForChannel(channel: SocialAccountChannel): string {
  return channel === "reddit" ? "test" : "feed";
}

export function connectionLabel(connection: Connection, fallback?: string): string {
  return (
    connection.displayName ||
    connection.externalAccountName ||
    connection.externalAccountHandle ||
    fallback ||
    connection.providerKey
  );
}

export function personaAccountOptions({
  connections,
  assignments,
  personaId,
  channel,
}: {
  connections: Connection[];
  assignments?: PersonaSocialAccount[] | null;
  personaId?: string | null;
  channel?: string;
}): Connection[] {
  const connected = connections.filter((connection) => connection.status === "connected");
  if (!personaId) return connected;

  const providerKey = channel ? providerForPersonaSocialChannel(channel) : null;
  const allowedConnectionIds = new Set(
    (assignments ?? [])
      .filter(
        (assignment) =>
          (!channel || assignment.channel === channel) &&
          (!providerKey || assignment.providerKey === providerKey),
      )
      .map((assignment) => assignment.connectionId),
  );

  return connected.filter((connection) => allowedConnectionIds.has(connection.id));
}

export function primaryConnectionForChannel(
  connections: Connection[],
  assignments: PersonaSocialAccount[],
  channel: string,
): Connection | undefined {
  const providerKey = providerForPersonaSocialChannel(channel);
  if (!providerKey) return undefined;

  const connectedById = new Map(
    connections
      .filter((connection) => connection.status === "connected")
      .map((connection) => [connection.id, connection]),
  );
  const primary = assignments.find(
    (assignment) =>
      assignment.isPrimary &&
      assignment.channel === channel &&
      assignment.providerKey === providerKey &&
      connectedById.has(assignment.connectionId),
  );

  return primary ? connectedById.get(primary.connectionId) : undefined;
}

export function launchChannelReady(
  channel: LaunchChannel,
  connections: Connection[],
  personaId: string | null | undefined,
  assignmentsByPersona: Record<string, PersonaSocialAccount[] | undefined>,
): boolean {
  if (channel === "email") return true;
  const providerKey = providerForPersonaSocialChannel(channel);
  if (!providerKey) return false;

  const providerConnected = connections.some(
    (connection) => connection.providerKey === providerKey && connection.status === "connected",
  );
  if (!providerConnected) return false;
  if (!personaId) return true;

  return Boolean(
    primaryConnectionForChannel(connections, assignmentsByPersona[personaId] ?? [], channel),
  );
}
