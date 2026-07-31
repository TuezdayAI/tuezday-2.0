# Instagram Direct Login Setup Copy Design

**Date:** 2026-07-31
**Branch:** `sprint-50-provider-repair-dedupe`

## Problem

The Integrations page still tells an operator without Instagram credentials to
create a Facebook app using the legacy Instagram Graph API and a Facebook Page.
Sprint 50 now connects Instagram through direct Instagram Login, so that setup
copy contradicts the implemented authentication architecture and can mislead an
operator during founder acceptance.

## Decision

Update only the Instagram entry in `OAUTH_APP_HINTS` on the Integrations page.
The hint will direct the operator to configure a Meta developer app with
**Instagram API with Instagram Login**, register the existing Nango callback
URL, request the direct-login scopes used by the connector, and set
`INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET`.

The hint must not describe a Facebook Page dependency, Facebook Login, or the
legacy Facebook Graph API flow.

## Scope

- Correct the operator-facing Instagram setup wording.
- Add a focused regression test that verifies the direct-login wording and
  rejects the legacy setup language.
- Run the focused test and web typecheck.
- Restart the API and web development servers on the Sprint 50 branch and
  verify the web root and API health endpoint.

No connector behavior, OAuth scopes, environment-variable names, database
schema, or other provider instructions will change.

## Acceptance Criteria

1. The Instagram setup hint names **Instagram API with Instagram Login**.
2. It shows the Nango callback URL and the direct-login scopes already used by
   the connector.
3. It identifies `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` as the app
   credentials.
4. It contains no legacy Facebook Page or Facebook Graph API setup guidance.
5. The regression test and web typecheck pass.
6. The restarted web app returns HTTP 200 and `/health` reports the API and
   database as healthy.
