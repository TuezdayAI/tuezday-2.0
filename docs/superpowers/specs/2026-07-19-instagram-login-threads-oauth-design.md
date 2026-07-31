# Instagram Login and Threads OAuth design

## Goal

Replace the current Facebook Login-based Instagram connection with Instagram Login, and add Threads as a separate OAuth connection. Both must appear in the Integrations hub, create durable workspace-scoped connections, and use the existing connection lifecycle without weakening credential handling.

## Scope

### Instagram Login migration

- Change the Instagram provider from Nango's `facebook` provider to its `instagram` provider.
- Replace Facebook Graph permissions with the Instagram Login permission set accepted by the configured Meta product.
- Update the Instagram adapter and connected-discovery calls to use the Instagram Login token and API host rather than resolving an Instagram account through Facebook Pages.
- Keep existing connected Instagram rows readable. New connections use the new provider configuration; old Facebook Login rows are shown as needing reconnection.

### Threads OAuth

- Add `threads` to the connector registry, social routing, provider display metadata, OAuth credential mapping, and Integrations hub.
- Add `THREADS_CLIENT_ID` and `THREADS_CLIENT_SECRET` to the documented local environment configuration.
- Define and provision a Threads OAuth provider configuration in self-hosted Nango. The installed Nango version does not ship a `threads` provider, so this configuration must own its authorization URL, token URL, refresh behavior, API base URL, and allowed scopes.
- Reuse the existing Nango popup/session/complete lifecycle; connections remain separate records from Instagram connections.

## Architecture

`Integrations UI` requests an OAuth session from `Connector routes`. The route validates the provider's local credentials and a healthy Nango fabric, ensures the provider configuration is current, then returns a Nango connect-session token. Nango handles the redirect and encrypted token storage. On completion, Tuezday records a workspace connection with the provider key and tests it through the existing fabric seam.

Instagram and Threads remain distinct at every boundary:

| Concern | Instagram | Threads |
| --- | --- | --- |
| Provider key | `instagram` | `threads` |
| OAuth credentials | `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` | `THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET` |
| Nango provider | built-in `instagram` | custom `threads` configuration |
| Connection row | one Instagram account | one Threads profile |
| Existing data | Facebook Login rows require reconnect | new capability |

## Error handling

- Missing app credentials keep the card in the existing “needs OAuth app” state and give the exact required variable names.
- An unavailable Nango service disables Connect with the existing fabric-health message.
- OAuth cancellation or Meta rejection remains a non-destructive failure: no connection row is created.
- A legacy Instagram Facebook Login row is marked/reported as reconnect-needed instead of silently treating it as an Instagram Login connection.

## Testing

- Contracts: registry, routing, and environment credential lookup for Threads and Instagram Login.
- API: OAuth-session endpoints prove correct provider configuration, scopes, missing credential responses, and no connection record on failed completion.
- Web: Integrations card renders Threads, correct setup guidance, and the shared popup flow.
- Migration compatibility: legacy Instagram connection records remain listable and are explicitly identified as requiring reconnect.

## Acceptance criteria

1. Instagram Login no longer requests the rejected Facebook Login permissions.
2. Instagram and Threads each have an independently connectable card once their credentials are configured.
3. Each OAuth completion creates exactly one connection under the appropriate provider key.
4. Existing LinkedIn, X, Reddit, and Meta Ads behavior remains unchanged.
5. New and changed coverage passes alongside the API and web type checks.
