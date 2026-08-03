import { describe, expect, it } from "vitest";
import { draftApprovalFingerprint } from "../src/services/draft-approval-fingerprint";

const DRAFT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function draft(overrides: Partial<{ id: string; content: string; mediaJson: string | null }> = {}) {
  return {
    id: DRAFT_ID,
    content: "Ship the thing on Tuezday.",
    mediaJson: null as string | null,
    ...overrides,
  };
}

describe("draftApprovalFingerprint", () => {
  it("returns a 64-char lowercase sha256 hex digest", () => {
    expect(draftApprovalFingerprint(draft())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is identical for the same draft id, content and media", () => {
    const media = JSON.stringify([{ url: "https://cdn.test/a.png", type: "image" }]);
    expect(draftApprovalFingerprint(draft({ mediaJson: media }))).toBe(
      draftApprovalFingerprint(draft({ mediaJson: media })),
    );
  });

  it("changes when the content changes", () => {
    expect(draftApprovalFingerprint(draft())).not.toBe(
      draftApprovalFingerprint(draft({ content: "Ship the thing on Wednesday." })),
    );
  });

  it("changes when only the media changes — swapping the image re-arms the gate", () => {
    const before = draftApprovalFingerprint(
      draft({ mediaJson: JSON.stringify([{ url: "https://cdn.test/a.png", type: "image" }]) }),
    );
    const after = draftApprovalFingerprint(
      draft({ mediaJson: JSON.stringify([{ url: "https://cdn.test/b.png", type: "image" }]) }),
    );
    expect(after).not.toBe(before);
  });

  it("distinguishes media present from media absent", () => {
    expect(
      draftApprovalFingerprint(
        draft({ mediaJson: JSON.stringify([{ url: "https://cdn.test/a.png", type: "image" }]) }),
      ),
    ).not.toBe(draftApprovalFingerprint(draft({ mediaJson: null })));
  });

  it("is deterministic and stable for null media", () => {
    const first = draftApprovalFingerprint(draft({ mediaJson: null }));
    const second = draftApprovalFingerprint(draft({ mediaJson: null }));
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when the draft id changes even with identical content", () => {
    expect(draftApprovalFingerprint(draft())).not.toBe(
      draftApprovalFingerprint(draft({ id: "1f0c4b3a-0000-4000-8000-000000000001" })),
    );
  });
});
