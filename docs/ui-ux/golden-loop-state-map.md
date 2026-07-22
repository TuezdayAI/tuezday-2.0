# Golden Operating Loop State Map

| Step | Entry | Primary action | Completion | Recovery | Analytics event |
|---|---|---|---|---|---|
| Home priority | workspace open | Open ranked item | relevant context opens | retry Home data; link to affected surface | `home.next_action_opened` |
| Campaign context | Home or Campaigns | Open work requiring action | campaign, plan, and lane context visible | create/backfill plan or open blocker | `campaign.context_opened` |
| Review queue | Home, Campaign, Calendar | Open next review item | editor opens in filtered queue | preserve filter and retry item | `review.item_opened` |
| Revision | review editor | Request or make change | preview updates and decision remains pending | preserve prior version and explain failure | `review.revision_requested` |
| Content decision | review editor | Approve or reject content | decision recorded | preserve item and show API error | `review.content_decided` |
| Authorization | review editor | Authorize external action | authorization recorded separately | explain policy/setup blocker | `review.action_authorized` |
| Scheduling | review editor or Calendar | Set destination and time | item becomes Scheduled | preserve approved content and retry scheduling | `calendar.item_scheduled` |
| Execution | Calendar | Inspect active or completed action | per-destination result visible | retry safe failures; link setup for blocked destinations | `execution.result_viewed` |

Required cross-cutting states: loading, sample, empty, review required, authorization required, generating, scheduled, active, completed, setup required, policy blocked, partially failed, failed, stale, and all-clear.
