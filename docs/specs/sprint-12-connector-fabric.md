# Spec: Sprint 12 — Connector Fabric

> Status: in build
> Covers Phase 11 of the rebuild plan. Stops one-off integrations before they start: a connector registry, a connection object, a webhook/event contract, and Nango deployed strictly as a **separate service** (Elastic license — its code never enters this repo; we use only its published images and REST API, exactly like R2R).

## What this slice does

Two halves, both native at the boundary:

1. **Connections through Nango.** A registry of providers Tuezday knows about (Smartlead, Instantly, Pipedrive, and a fully founder-configurable `custom` API). API-key/basic providers connect by pasting credentials — **credentials live in Nango, never in Tuezday's DB**. Tuezday stores only the connection state: provider, Nango connection id, status, last check. Health-check, test request (through Nango's authenticated proxy), disconnect, reconnect.
2. **Webhook/event contract.** Tuezday emits domain events (`draft.approved`, `draft.rejected`, `discovery.item.accepted`, `synthesis.accepted`) into an event log, and delivers them to registered webhook endpoints with an HMAC-SHA256 signature (`X-Tuezday-Signature`) — the shape later integrations (Activepieces automations, CRM writebacks) will consume.

## Out of scope

OAuth connect flows (need per-provider OAuth apps + the Nango Connect UI — the registry marks OAuth providers `needs_oauth_app`, connectable later without schema changes), webhook retries/queues (deliveries are recorded with their result; the worker can replay later), inbound webhooks from providers, actual CRM/sender API usage (Sprint 13+).

## Deployment

`infra/nango/compose.yaml`: published `nangohq/nango-server` image + its own Postgres (port 5434), server on **:3050**. Generated `NANGO_SECRET_KEY_DEV` + `NANGO_ENCRYPTION_KEY` stored in the root `.env` (gitignored; `.env.example` updated). `npm run nango:up` / `nango:down`. Everything degrades gracefully when Nango is down (status banner, 503s on connect, connections marked `error` on health check).

## Behavior

### Registry (contracts)

`CONNECTOR_PROVIDERS`: `{ key, label, nangoProvider (template from Nango's providers.yaml), authMode (api_key | basic | oauth), baseUrl?, testPath? }` — Smartlead, Instantly, Pipedrive (api_key); HubSpot, Salesforce, Slack (oauth → `needs_oauth_app`); `custom` (api_key + founder-supplied base URL/test path, Nango template `unauthenticated`-style header auth via Base-Url-Override).

### ConnectorFabric boundary (`apps/api/src/connectors/`)

Interface: `health`, `ensureIntegration(uniqueKey, provider)`, `importConnection` (POST `/connections` with API_KEY/BASIC credentials), `getConnection`, `deleteConnection`, `proxyGet(path, connectionId, providerConfigKey, baseUrlOverride?)`. Nango implementation with injectable fetcher; secret key from `NANGO_SECRET_KEY` env; base url `NANGO_BASE_URL` (default `http://localhost:3050`).

### Connections (Tuezday-side)

`connections` table: id, workspaceId, providerKey, nangoConnectionId, configJson (custom base url/test path), status (`connected` | `error` | `disconnected`), lastCheckedAt, lastError, createdAt.

| Endpoint | Behavior |
|---|---|
| `GET /connectors` | registry + this workspace's connections + Nango health |
| `POST /connectors/:providerKey/connect` | body `{apiKey?\|username/password?, baseUrl?, testPath?}` → ensure integration in Nango, import connection, store row `connected`. `503` Nango down; `409` already connected. |
| `POST /connections/:connectionId/test` | health (connection exists in Nango) + proxy test request when a test path is known → `{ok, status?, detail}`; updates status/lastError |
| `DELETE /connections/:connectionId` | delete in Nango + mark `disconnected` (row kept for history; reconnect creates a fresh connection) |

### Events + webhooks

- `events` (append-only): id, workspaceId, type, payloadJson, createdAt. Emitted from draft approve/reject, discovery accept, synthesis accept.
- `webhook_subscriptions`: id, workspaceId, url, secret, eventTypesJson, enabled, createdAt.
- `webhook_deliveries`: id, subscriptionId, eventId, status (`delivered` | `failed`), httpStatus, error, createdAt. Delivery: POST `{id, type, workspaceId, payload, createdAt}` with `X-Tuezday-Signature: sha256=<hmac of body>`; failures recorded, never break the triggering action.
- Routes: webhook CRUD, `POST /webhooks/:id/ping` (test event), `GET /events` (log with delivery summaries).

### Web (`/workspaces/[id]/connectors`)

Nango status banner; provider cards (connect form per auth mode, custom base-url form; connected cards show status + Test + Disconnect; oauth cards show "needs OAuth app — coming with provider setup"); webhooks panel (add url + event types, ping, enable/disable, delete); recent events with delivery badges.

## Automated verification

- Contracts: registry shape, webhook/connect input validation.
- Nango client: request shapes (integration ensure, import bodies for API_KEY/BASIC, proxy headers incl. Base-Url-Override, delete) against a fixture fetcher; health mapping.
- API (fake fabric): connect happy path stores no credentials locally; duplicate 409; Nango-down 503; test updates status both ways; disconnect→reconnect; custom provider config.
- Events: each emission point writes an event; subscribed webhooks receive signed payloads (fixture fetcher verifies HMAC); failed delivery recorded without failing the approve; ping; event-type filtering.

## Founder acceptance checklist

1. `npm run nango:up`; the connectors page shows Nango healthy.
2. Connect the `custom` provider pointed at any API you have (or a Smartlead/Instantly key if available) → status `connected`, **Test** makes a real request through Nango's proxy.
3. Disconnect → reconnect works.
4. Add a webhook (webhook.site or local echo) for `draft.approved` → approve any draft → the signed event arrives; the event log shows the delivery.
