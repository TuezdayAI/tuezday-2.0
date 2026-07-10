import type { Channel } from "@tuezday/contracts";

export type PreviewKind = "social" | "email" | "blog" | "ad";

/** Which PreviewCard renderer a channel uses (spec §6.1). PR pitches read as email. */
export function previewKindFor(channel: Channel): PreviewKind {
  switch (channel) {
    case "linkedin":
    case "x":
    case "instagram":
      return "social";
    case "email":
    case "pr":
      return "email";
    case "web":
      return "blog";
    case "ads":
      return "ad";
    default: {
      const exhaustive: never = channel;
      throw new Error(`Unmapped channel: ${exhaustive as string}`);
    }
  }
}
