import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL, resolveDatabaseUrl } from "../src/runtime/database-url";

describe("resolveDatabaseUrl", () => {
  it("defaults to the local development server when DATABASE_URL is unset", () => {
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });

  it("defaults when DATABASE_URL is empty", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "" })).toBe(DEFAULT_DATABASE_URL);
  });

  it("defaults when DATABASE_URL is whitespace-only", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "   " })).toBe(DEFAULT_DATABASE_URL);
  });

  it("returns an explicit DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.internal:5432/tuezday" })).toBe(
      "postgres://u:p@db.internal:5432/tuezday",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL: "  postgres://u:p@db.internal:5432/tuezday  " }),
    ).toBe("postgres://u:p@db.internal:5432/tuezday");
  });

  // The default is loopback on purpose: a container that forgets DATABASE_URL
  // must fail its production-env check, never quietly reach a real server.
  it("keeps the fallback on loopback", () => {
    expect(new URL(DEFAULT_DATABASE_URL).hostname).toBe("localhost");
  });
});
