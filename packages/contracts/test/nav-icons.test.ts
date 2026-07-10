import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV } from "../src/index.js";

describe("workspace nav icons", () => {
  it("every group and child declares an icon name", () => {
    for (const item of WORKSPACE_NAV) {
      expect(item.icon, item.label).toBeTruthy();
      for (const child of item.children ?? []) {
        expect(child.icon, `${item.label} > ${child.label}`).toBeTruthy();
      }
    }
  });
});
