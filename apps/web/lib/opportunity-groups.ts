// Pure grouping for the opportunities page (Sprint 61) — kept in lib so it is
// unit-tested (node env). Groups a fetched opportunity list by canonical story,
// preserving fetch order; story-less opportunities (manual signals, §8.6 XOR)
// collect under one "Manual signal" group.

/** The story fields grouping needs — CampaignOpportunity satisfies this. */
export interface OpportunityStoryRef {
  canonicalStoryId: string | null;
  storyTitle: string | null;
  storyUrl: string | null;
}

export interface OpportunityGroup<T extends OpportunityStoryRef> {
  /** canonicalStoryId, or MANUAL_GROUP_KEY for manual-signal opportunities. */
  key: string;
  title: string;
  url: string | null;
  opportunities: T[];
}

export const MANUAL_GROUP_KEY = "manual";
export const MANUAL_GROUP_LABEL = "Manual signal";

export function groupOpportunitiesByStory<T extends OpportunityStoryRef>(
  opportunities: T[],
): OpportunityGroup<T>[] {
  const groups = new Map<string, OpportunityGroup<T>>();
  for (const opp of opportunities) {
    const key = opp.canonicalStoryId ?? MANUAL_GROUP_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title:
          opp.canonicalStoryId === null
            ? MANUAL_GROUP_LABEL
            : (opp.storyTitle ?? "Untitled story"),
        url: opp.canonicalStoryId === null ? null : opp.storyUrl,
        opportunities: [],
      };
      groups.set(key, group);
    }
    group.opportunities.push(opp);
  }
  return [...groups.values()];
}
