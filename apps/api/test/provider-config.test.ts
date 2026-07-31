import { describe, expect, it } from "vitest";
import {
  assertProviderConfiguration,
  linkedinApiVersion,
  linkedinRestHeaders,
  operatorFlagEnabled,
} from "../src/connectors/provider-config";
import {
  providerByKey,
  resolveOAuthScopes,
} from "../src/services/connections";

describe("provider configuration", () => {
  it("uses the July 2026 LinkedIn version by default", () => {
    expect(linkedinApiVersion({})).toBe("202607");
    expect(linkedinRestHeaders({})).toEqual({
      "LinkedIn-Version": "202607",
      "X-Restli-Protocol-Version": "2.0.0",
    });
  });

  it("accepts one six-digit operator override and rejects malformed values", () => {
    expect(
      linkedinApiVersion({ LINKEDIN_API_VERSION: " 202608 " }),
    ).toBe("202608");
    expect(() =>
      assertProviderConfiguration({
        LINKEDIN_API_VERSION: "2026-08",
      }),
    ).toThrow(/LINKEDIN_API_VERSION must be exactly six digits/);
  });

  it.each(["true", "TRUE", " 1 ", "yes", "On"])(
    "treats %s as enabled",
    (value) => expect(operatorFlagEnabled(value)).toBe(true),
  );

  it.each([undefined, "", "false", "0", "no", "off", "anything"])(
    "treats %s as disabled",
    (value) => expect(operatorFlagEnabled(value)).toBe(false),
  );

  it("adds both approval-gated LinkedIn read scopes only when enabled", () => {
    const linkedin = providerByKey("linkedin")!;
    expect(resolveOAuthScopes(linkedin, {})).toBe(
      "openid,profile,email,w_member_social",
    );
    expect(
      resolveOAuthScopes(linkedin, {
        LINKEDIN_COMMUNITY_APPROVED: "true",
      }),
    ).toBe(
      "openid,profile,email,w_member_social,r_member_social,r_organization_social",
    );
    expect(
      resolveOAuthScopes(linkedin, {
        LINKEDIN_COMMUNITY_APPROVED: "false",
      }),
    ).toBe("openid,profile,email,w_member_social");
  });
});
