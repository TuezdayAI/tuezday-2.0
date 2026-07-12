# UI/UX Revamp Capability Registry

> Baseline: `integration/gtm-foundation@1e38c14`
> Scope: golden operating loop plus placement of every current workspace route

| Capability | Existing API/contract | Current route | Target surface | Treatment | Required states | Migration |
|---|---|---|---|---|---|---|
| Ranked next action | `GET /workspaces/:id/next-action`, `NextAction` | workspace Home | Home / Up next | Tuezday extension | loading, all-clear, actionable, system-working, error | retain and restyle |
| Campaign inventory | `GET/POST /workspaces/:id/campaigns` | `/campaigns` | Campaigns | Blaze extension | empty, loading, active, paused, error | retain |
| Campaign control plane | `GET /workspaces/:id/campaigns/:campaignId/plan/summary` | API only | Campaign / Overview | Tuezday exclusive | missing-plan, ready, blocked, partial, error | add UI in golden-loop plan |
| Plan revisions | campaign plan revision contracts and routes | API only | Campaign / Plan history | Tuezday exclusive | current, draft revision, invalid, immutable, activated | add UI in campaign plan |
| Campaign lanes | lane revision contracts and routes | API only | Campaign / Channels | Tuezday exclusive | empty, configured, generating, blocked, stale | add UI in campaign plan |
| Review queue | draft list/detail/decision routes | `/approvals` | Review / Approvals | Blaze extension | empty, loading, review required, approved, rejected, partial, error | retain and migrate to canonical status |
| Carousel rendering | `POST /workspaces/:id/drafts/:draftId/carousel` | `/approvals` | Review editor / Quick edits | Tuezday extension | eligible, rendering, rendered, failed | retain merged behavior |
| Destination preview | `Draft`, `LaunchMedia`, `PreviewCard` | Home, Approvals, Calendar | Shared preview | Blaze extension | text-only, image, carousel, unsupported, loading | extend in golden-loop plan |
| Content approval | draft approve/reject/edit routes | `/approvals` | Review / Approvals | direct match plus audit | review required, edited, approved, rejected, error | retain behavior |
| External-action authorization | action policy and orchestration contracts | automation and execution routes | Review / Authorization | Tuezday exclusive | authorization required, authorized, policy blocked, stale | add UI in golden-loop plan |
| Calendar | draft/publication/cadence APIs | `/calendar` | Calendar | Blaze extension | empty, planned, review required, scheduled, executing, partial, failed | retain route, rebuild anatomy later |
| Publication execution | publication routes | Calendar and channel pages | Editor / Execution plus Calendar | Tuezday extension | scheduling, scheduled, publishing, completed, partially failed, failed | expose consistently later |
| Connection recovery | connector routes and capability view | `/connectors` and inline prompts | Integrations plus contextual recovery | direct match | setup required, connecting, connected, connection lost, failed | retain and standardize later |
| Brain evidence disclosure | resolver/evidence contracts | `/brain`, `/evidence`, `/resolver` | Editor / Why Tuezday made this | Tuezday exclusive | available, partial evidence, unavailable, error | retain APIs, move disclosure into editor later |
| Learning suggestions | synthesis routes | `/learning` | Insights / Learning | Tuezday extension | empty, proposed, accepted, rejected, error | move navigation; retain route |
