# Desktop acceptance tests

This suite verifies the completed platform UI at desktop viewport widths only. It deliberately does
not encode mobile acceptance requirements.

Run it from the repository root:

```sh
npm run test:desktop
```

The Playwright configuration starts only the Next.js application. `fixtures.ts` intercepts the API
origin and supplies an authenticated, deterministic in-memory dataset, so the suite never changes a
developer database or depends on third-party services.

## Coverage

- Command Center at 1024, 1280, 1440, and 1728 pixels.
- Minimum 36/40-pixel control heights for compact and standard actions.
- No document-level horizontal overflow at the supported widths.
- Batch authorization preview, bounded dialog geometry, and durable partial outcomes.
- Workspace, connection, and persona action-policy editors.
- Verified native-email sender setup and DNS state.
- Meta provider-state budget mutation.
- Governed native-email delivery status.

The tests write screenshots, traces, and videos beneath `test-results/desktop`. Those files are
diagnostic evidence for the current run and are intentionally ignored by Git; there are no golden
image snapshots to maintain.

Campaign and active-lane policy mounting remains covered by the focused Vitest source contracts in
`apps/web/lib/action-policy-controls.test.ts` and `apps/web/lib/lane-policy-shell.test.ts`. The shared
editor behavior is covered by `apps/web/lib/scoped-action-policy.test.ts`.
