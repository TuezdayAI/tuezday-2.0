import { describe, expect, it } from "vitest";
import { CHANNELS } from "@tuezday/contracts";
import { previewKindFor } from "./preview-kind";

describe("previewKindFor", () => {
  it("maps every channel to a renderer kind", () => {
    for (const channel of CHANNELS) {
      expect(["social", "email", "blog", "ad"]).toContain(previewKindFor(channel));
    }
  });
  it("maps the known channels correctly", () => {
    expect(previewKindFor("linkedin")).toBe("social");
    expect(previewKindFor("x")).toBe("social");
    expect(previewKindFor("instagram")).toBe("social");
    expect(previewKindFor("email")).toBe("email");
    expect(previewKindFor("web")).toBe("blog");
    expect(previewKindFor("pr")).toBe("email");
    expect(previewKindFor("ads")).toBe("ad");
  });
});
