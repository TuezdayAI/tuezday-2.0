// Design-provider boundary (Sprint 41 Part 3). Same posture as
// EvidenceStore/R2R and ConnectorFabric/Nango: Tuezday owns this interface;
// Open Design runs as its own self-hosted service behind it. Services depend
// on the interface only — provider code never leaks past this file's types.

export interface AuthorTemplateInput {
  /** From the curated allowlist only — never the full Open Design catalog. */
  skillId: string;
  /** Resolved content from resolveDesignSystem() (base + winning overlay). */
  designSystemMarkdown: string;
  /** Slide archetype ("hook", "cta", …) or ad shape ("ad-1080x1080"). */
  slideShape: string;
  /** e.g. "a 1080x1080 carousel slide template: title, body, page indicator". */
  brief: string;
}

export interface AuthoredTemplate {
  html: string;
  css: string;
  /** {{token}} names the template left in place for the renderer to fill. */
  placeholders: string[];
}

export interface DesignProvider {
  authorTemplate(input: AuthorTemplateInput): Promise<AuthoredTemplate>;
}

/** Any daemon/auth/timeout failure. Callers surface "design service
 * unavailable, try again" — text-only flows are never blocked by this. */
export class DesignProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignProviderError";
  }
}

/** Extract unique {{token}} names in first-appearance order. */
export function extractPlaceholders(html: string): string[] {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    if (match[1]) tokens.add(match[1]);
  }
  return [...tokens];
}
