import {
  SOCIAL_READ_PROVIDERS,
  type SocialCorpus,
  type SocialCorpusEntry,
  type SocialProfileRead,
  type SocialReadProvider,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor } from "../connectors/social";
import { listConnections, providerByKey } from "./connections";

// Same ceiling as the 36.2 website corpus — the two are concatenated by the
// brain auto-draft (36.4), so keep them the same order of magnitude.
const MAX_CORPUS_CHARS = 20_000;

function socialConnections(db: Db, workspaceId: string) {
  const social = new Set<string>(SOCIAL_READ_PROVIDERS);
  return listConnections(db, workspaceId).filter(
    (c) => c.status === "connected" && social.has(c.providerKey),
  );
}

/** True iff the workspace has at least one connected social account (min-1 gate). */
export function hasSocialConnection(db: Db, workspaceId: string): boolean {
  return socialConnections(db, workspaceId).length > 0;
}

function profileSection(profile: SocialProfileRead): string {
  const lines = [
    `# ${profile.provider}${profile.handle ? ` @${profile.handle}` : ""}`,
    profile.displayName,
    profile.bio,
    ...(profile.recentPosts.length ? ["Recent posts:"] : []),
    ...profile.recentPosts.map((p) => `- ${p.text}`),
  ];
  return lines.filter((l) => l.trim().length > 0).join("\n");
}

/**
 * Read the connected social accounts' own profiles + recent posts into one
 * corpus. Read-on-demand — nothing is persisted; a failing platform becomes a
 * per-provider error entry and never sinks the others.
 */
export async function readSocialCorpus(
  db: Db,
  fabric: ConnectorFabric,
  workspaceId: string,
): Promise<SocialCorpus> {
  const conns = socialConnections(db, workspaceId);

  const entries: SocialCorpusEntry[] = [];
  const sections: string[] = [];

  for (const conn of conns) {
    const providerKey = conn.providerKey as SocialReadProvider;
    const provider = providerByKey(providerKey);
    if (!provider) continue;
    const adapter = socialAdapterFor(fabric, provider, conn);
    if (!adapter?.readSocialProfile) {
      entries.push({ provider: providerKey, profile: null, error: "read not supported" });
      continue;
    }
    try {
      const raw = await adapter.readSocialProfile();
      const profile: SocialProfileRead = {
        provider: providerKey,
        handle: raw.handle,
        displayName: raw.displayName,
        bio: raw.bio.slice(0, 3000),
        recentPosts: raw.recentPosts
          .slice(0, 25)
          .map((p) => ({ text: p.text.slice(0, 5000), url: p.url, createdAt: p.createdAt })),
      };
      entries.push({ provider: providerKey, profile, error: null });
      sections.push(profileSection(profile));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ provider: providerKey, profile: null, error: message.slice(0, 500) });
    }
  }

  return {
    connected: conns.map((c) => c.providerKey as SocialReadProvider),
    entries,
    corpus: sections.join("\n\n").slice(0, MAX_CORPUS_CHARS),
  };
}
