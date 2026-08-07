import { describe, expect, it } from "vitest";
import type { ChatCard, ChatPin } from "@tuezday/contracts";
import {
  cardActionRequest,
  cardHasAction,
  cardHref,
  cardIsInteractive,
  cardKindLabel,
  cardRecordId,
  clearMention,
  commandQuery,
  mentionQuery,
  pastedUrl,
  pinIsUntrusted,
  pinsSummary,
} from "./chat-card-view";
import { describeDiff, diffWords, hasChanges } from "./text-diff";

const WS = "ws-1";

function card(overrides: Partial<ChatCard> = {}): ChatCard {
  return {
    kind: "draft",
    ref: "draft:d-1",
    title: "Our funding post",
    subtitle: "pending_review",
    fields: [],
    body: "We raised a seed round.",
    actions: ["open", "approve", "reject", "edit"],
    ...overrides,
  } as ChatCard;
}

describe("where a card goes", () => {
  it("routes each ref to the page that governs the record", () => {
    expect(cardHref(card({ ref: "draft:d-1" }), WS)).toBe("/workspaces/ws-1/review?draft=d-1");
    expect(cardHref(card({ kind: "campaign", ref: "campaign:c-1" }), WS)).toBe(
      "/workspaces/ws-1/campaigns/c-1",
    );
    expect(cardHref(card({ kind: "publication", ref: "publication:p-1" }), WS)).toBe(
      "/workspaces/ws-1/content?publication=p-1",
    );
    expect(cardHref(card({ kind: "signal", ref: "discovery_item:i-1" }), WS)).toBe(
      "/workspaces/ws-1/discovery?item=i-1",
    );
    expect(cardHref(card({ kind: "evidence", ref: "evidence:doc-1" }), WS)).toBe(
      "/workspaces/ws-1/evidence?document=doc-1",
    );
    // A brain ref carries an anchor the page does not take; the doc does.
    expect(cardHref(card({ kind: "brain", ref: "brain:voice#tone" }), WS)).toBe(
      "/workspaces/ws-1/brain?doc=voice",
    );
    expect(cardHref(card({ kind: "metric", ref: "workspace:insights" }), WS)).toBe(
      "/workspaces/ws-1/insights",
    );
  });

  it("returns null rather than a link that lands somewhere wrong", () => {
    expect(cardHref(card({ ref: "nonsense" }), WS)).toBeNull();
    expect(cardHref(card({ ref: "draft:" }), WS)).toBeNull();
    expect(cardHref(card({ ref: "unknown_kind:x" }), WS)).toBeNull();
  });

  it("extracts the record id the action routes need", () => {
    expect(cardRecordId(card({ ref: "draft:d-9" }))).toBe("d-9");
    expect(cardRecordId(card({ ref: "bare" }))).toBeNull();
  });
});

describe("card actions call the pages' own routes (D-77.3)", () => {
  it("builds the identical request /review issues", () => {
    // This is the whole "no parallel mutation path" claim: same method, same
    // path, so the decision-log record is written by the same code.
    expect(cardActionRequest(card(), "approve", WS)).toEqual({
      path: "/workspaces/ws-1/drafts/d-1/approve",
      method: "POST",
    });
    expect(cardActionRequest(card(), "reject", WS)?.path).toBe(
      "/workspaces/ws-1/drafts/d-1/reject",
    );
    expect(cardActionRequest(card(), "edit", WS)?.path).toBe("/workspaces/ws-1/drafts/d-1/edit");
  });

  it("offers nothing for a kind with no route", () => {
    expect(cardActionRequest(card({ kind: "campaign", ref: "campaign:c-1" }), "approve", WS)).toBeNull();
  });

  it("distinguishes a card you can act on from one you can only open", () => {
    expect(cardIsInteractive(card())).toBe(true);
    expect(cardIsInteractive(card({ actions: ["open"] }))).toBe(false);
    expect(cardHasAction(card({ actions: ["open"] }), "approve")).toBe(false);
  });

  it("labels every kind", () => {
    expect(cardKindLabel("draft")).toBe("Draft");
    expect(cardKindLabel("metric")).toBe("Metrics");
  });
});

describe("pins", () => {
  const pin = (overrides: Partial<ChatPin> = {}): ChatPin =>
    ({
      id: "p-1",
      workspaceId: WS,
      sessionId: "s-1",
      kind: "campaign",
      refId: "c-1",
      label: "Spring Launch",
      createdAt: 1,
      ...overrides,
    }) as ChatPin;

  it("states the consequence, not just the count", () => {
    expect(pinsSummary([])).toBeNull();
    expect(pinsSummary([pin()])).toBe("1 thing is pinned to this conversation — every turn sees it.");
    expect(pinsSummary([pin(), pin({ id: "p-2" })])).toContain("2 things are pinned");
  });

  it("marks the two kinds nobody in the workspace wrote", () => {
    expect(pinIsUntrusted(pin({ kind: "url" }))).toBe(true);
    expect(pinIsUntrusted(pin({ kind: "signal" }))).toBe(true);
    expect(pinIsUntrusted(pin({ kind: "campaign" }))).toBe(false);
    expect(pinIsUntrusted(pin({ kind: "brain_section" }))).toBe(false);
  });
});

describe("the composer's triggers", () => {
  it("opens the palette only on a slash at the start of an empty composer", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/dra")).toBe("dra");
    // Mid-message slashes are prose, and a pasted URL is a pin, not a command.
    expect(commandQuery("approve/reject rates")).toBeNull();
    expect(commandQuery("/draft a post about funding")).toBeNull();
    expect(commandQuery("https://example.com/x")).toBeNull();
  });

  it("finds the @mention being typed, and clears it once pinned", () => {
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("tell me about @spr")).toBe("spr");
    expect(mentionQuery("tell me about @spring launch")).toBeNull();
    expect(mentionQuery("no mention here")).toBeNull();
    expect(clearMention("tell me about @spr")).toBe("tell me about ");
    expect(clearMention("@spr")).toBe("");
  });

  it("recognises a pasted http(s) URL and nothing else", () => {
    expect(pastedUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(pastedUrl("look at http://example.com/b please")).toBe("http://example.com/b");
    // safe-fetch would refuse these, so offering a chip would be a lie.
    expect(pastedUrl("file:///etc/passwd")).toBeNull();
    expect(pastedUrl("just some text")).toBeNull();
  });
});

describe("the inline edit's diff", () => {
  it("marks what was added and removed, keeping the rest equal", () => {
    const spans = diffWords("We raised a seed round.", "We raised a Series A round.");
    expect(spans.some((s) => s.op === "insert" && s.text.includes("Series"))).toBe(true);
    expect(spans.some((s) => s.op === "delete" && s.text.includes("seed"))).toBe(true);
    expect(spans.some((s) => s.op === "equal" && s.text.includes("We raised"))).toBe(true);
    // Lossless: the equal + delete spans rebuild the original exactly.
    expect(
      spans
        .filter((s) => s.op !== "insert")
        .map((s) => s.text)
        .join(""),
    ).toBe("We raised a seed round.");
    expect(
      spans
        .filter((s) => s.op !== "delete")
        .map((s) => s.text)
        .join(""),
    ).toBe("We raised a Series A round.");
  });

  it("says nothing changed when nothing did", () => {
    expect(diffWords("same", "same")).toEqual([{ op: "equal", text: "same" }]);
    expect(describeDiff(diffWords("same", "same"))).toBe("No changes.");
    expect(hasChanges("same", "  same  ")).toBe(false);
    expect(hasChanges("same", "different")).toBe(true);
  });

  it("summarises the change in words, which is the unit of a GTM edit", () => {
    expect(describeDiff(diffWords("a b c", "a b c d"))).toBe("1 word added.");
    expect(describeDiff(diffWords("a b c", "a"))).toBe("2 removed.");
    expect(describeDiff(diffWords("a b", "x b"))).toBe("1 word added, 1 removed.");
  });

  it("handles the empty cases without inventing spans", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("", "new")).toEqual([{ op: "insert", text: "new" }]);
    expect(diffWords("old", "")).toEqual([{ op: "delete", text: "old" }]);
  });
});
