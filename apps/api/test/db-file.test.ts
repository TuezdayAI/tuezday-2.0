import { describe, expect, it } from "vitest";
import { resolveDbFile } from "../src/runtime/db-file";

describe("resolveDbFile", () => {
  it("defaults to tuezday.db when TUEZDAY_DB is unset", () => {
    expect(resolveDbFile({})).toBe("tuezday.db");
  });

  it("defaults to tuezday.db when TUEZDAY_DB is empty", () => {
    expect(resolveDbFile({ TUEZDAY_DB: "" })).toBe("tuezday.db");
  });

  it("defaults to tuezday.db when TUEZDAY_DB is whitespace-only", () => {
    expect(resolveDbFile({ TUEZDAY_DB: "   " })).toBe("tuezday.db");
  });

  it("returns an explicit TUEZDAY_DB", () => {
    expect(resolveDbFile({ TUEZDAY_DB: "/data/tuezday.db" })).toBe(
      "/data/tuezday.db",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDbFile({ TUEZDAY_DB: "  /data/tuezday.db  " })).toBe(
      "/data/tuezday.db",
    );
  });
});
