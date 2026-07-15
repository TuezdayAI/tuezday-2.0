# Desktop platform completion acceptance

## Scope

This acceptance closes the desktop platform-completion sprint. Supported QA widths are 1024, 1280,
1440, and 1728 pixels. Mobile visual QA is intentionally out of scope for this desktop application.

## Automated desktop evidence

Run `npm run test:desktop`. Chromium exercises an authenticated deterministic fixture without a live
API, persistent database writes, or third-party effects. Each run captures diagnostic screenshots in
`test-results/desktop`.

| Surface | Automated assertion |
| --- | --- |
| Command Center | Ranked action is visible at all four widths; standard actions are at least 40px high; no horizontal overflow. |
| Review authorization batch | Selection creates an immutable preview; the dialog fits a 1280×900 viewport; confirmation preserves a partial failure and recovery link. |
| Action permissions | Workspace, connection, and persona editors render from deterministic effective-policy data. Campaign and active-lane mounting are enforced by their focused Vitest contracts. |
| Native sender | Verified address, sender form, action sizing, and DNS record state render without overflow. |
| Meta mutation | Provider state opens the budget-diff editor and keeps its guarded proposal action at least 40px high. |
| Native email | An explicitly allowed recipient can trigger the governed send and see the accepted delivery receipt. |

## Interaction and hierarchy acceptance

- Compact controls are at least 36px high; standard controls are at least 40px high.
- Decision regions expose one clear filled primary action. Destructive alternatives use the danger
  hierarchy and non-decision navigation uses secondary or tertiary actions.
- Buttons retain their width while showing the built-in loading indicator.
- Dialog content stays inside the desktop viewport and remains closable with Escape.
- Focusable controls use semantic buttons, links, form controls, and labelled regions; the acceptance
  suite locates them by role and accessible name rather than styling hooks.
- The supported desktop documents do not create page-level horizontal scrolling. Dense tables keep
  any necessary overflow inside their local wrapper.

## Policy-editor inventory

The action-policy hierarchy is one workspace default, optional campaign overrides, and
tightening-only persona, connection, and active-lane rules.

- Workspace: `/automation`, concrete human-required or autonomous defaults.
- Campaign: campaign Overview, inherit or override for each action kind.
- Persona: Context inspector, shown only while editing that persona.
- Connection: Integrations account detail, shown only for the expanded account.
- Active lane revision: campaign Channels, tightening only; immutable plan content remains separate.

The shared editor exposes inherited effective status and contributing rules so a stricter upstream
constraint is never mistaken for a failed save.

## Release gate

Before merging or releasing, all of the following must pass from a clean checkout:

```sh
npm test
npm run typecheck
npm run test:desktop
npm run build -w apps/web
```

Playwright traces, videos, and screenshots are run artifacts, not committed baselines.
