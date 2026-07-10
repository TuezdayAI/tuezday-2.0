import { describe, expect, it } from "vitest";
import { formatCount, formatProgress } from "./badge-format";

describe("badge formatting", () => {
  it("formats plain counts and caps at 99+", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(3)).toBe("3");
    expect(formatCount(99)).toBe("99");
    expect(formatCount(100)).toBe("99+");
  });
  it("formats progress as done/total, clamping done to total", () => {
    expect(formatProgress(1, 5)).toBe("1/5");
    expect(formatProgress(7, 5)).toBe("5/5");
    expect(formatProgress(0, 4)).toBe("0/4");
  });
});
