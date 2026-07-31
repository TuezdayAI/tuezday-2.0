import { ProviderCapabilityError } from "./provider-errors";

interface LinkedInOrganization {
  id?: number | string;
  vanityName?: string;
}

interface LinkedInOrganizationsResponse {
  elements?: LinkedInOrganization[];
}

export interface LinkedInOrganizationResolverInput {
  target: string;
  get(path: string): Promise<{ status: number; json: unknown }>;
}

export function normalizeLinkedInOrganizationSlug(
  value: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^urn:li:organization:\d+$/.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const match = url.pathname.match(
      /^\/(?:company|school)\/([^/]+)\/?$/i,
    );
    return match?.[1]
      ? decodeURIComponent(match[1]).toLowerCase()
      : null;
  }
  const slug = trimmed.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : null;
}

export async function resolveLinkedInOrganizationUrn(
  input: LinkedInOrganizationResolverInput,
): Promise<string> {
  const slug = normalizeLinkedInOrganizationSlug(input.target);
  if (slug?.startsWith("urn:li:organization:")) return slug;
  if (!slug) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      "LinkedIn discovery supports Company and School page handles only.",
    );
  }

  const response = await input.get(
    `/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(slug)}`,
  );
  const payload = response.json as LinkedInOrganizationsResponse;
  const exact = (payload.elements ?? []).find(
    (organization) =>
      organization.vanityName?.trim().toLowerCase() === slug &&
      /^\d+$/.test(String(organization.id ?? "")),
  );
  if (!exact) {
    throw new ProviderCapabilityError(
      "target_unresolvable",
      `LinkedIn Company or School page "${slug}" could not be resolved.`,
    );
  }
  return `urn:li:organization:${String(exact.id)}`;
}
