import { describe, expect, it, vi } from "vitest";
import {
  normalizeLinkedInOrganizationSlug,
  resolveLinkedInOrganizationUrn,
} from "../src/discovery/provider-account-resolvers";

describe("LinkedIn organization resolution", () => {
  it.each([
    ["@Acme", "acme"],
    ["acme", "acme"],
    ["https://www.linkedin.com/company/Acme/", "acme"],
    [
      "https://linkedin.com/school/Acme-University",
      "acme-university",
    ],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeLinkedInOrganizationSlug(value)).toBe(expected);
  });

  it("returns the exact vanity-name organization's URN", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      json: {
        elements: [
          { id: 42, vanityName: "other" },
          { id: 73, vanityName: "Acme" },
        ],
      },
    }));

    await expect(
      resolveLinkedInOrganizationUrn({ target: "@acme", get }),
    ).resolves.toBe("urn:li:organization:73");
    expect(get).toHaveBeenCalledWith(
      "/rest/organizations?q=vanityName&vanityName=acme",
    );
  });

  it("accepts a cached organization URN without a provider lookup", async () => {
    const get = vi.fn();
    await expect(
      resolveLinkedInOrganizationUrn({
        target: "urn:li:organization:73",
        get,
      }),
    ).resolves.toBe("urn:li:organization:73");
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed for a person URL or a missing exact organization", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      json: { elements: [] },
    }));
    await expect(
      resolveLinkedInOrganizationUrn({
        target: "https://linkedin.com/in/founder",
        get,
      }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
    await expect(
      resolveLinkedInOrganizationUrn({
        target: "missing-company",
        get,
      }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
  });

  it("fails closed for malformed organization results", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      json: {
        elements: [{ id: "not-numeric", vanityName: "acme" }],
      },
    }));
    await expect(
      resolveLinkedInOrganizationUrn({ target: "acme", get }),
    ).rejects.toMatchObject({ code: "target_unresolvable" });
  });
});
