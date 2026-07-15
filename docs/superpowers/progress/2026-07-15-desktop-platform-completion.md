# Desktop Platform Completion Progress

Baseline: `65936be` on `ui-revamp/desktop-platform-completion`  
Plan: `docs/superpowers/plans/2026-07-15-desktop-platform-completion.md`

| Task | Commit | RED evidence | GREEN evidence | Typecheck | Notes/deferrals |
|---:|---|---|---|---|---|
| 1 | same commit | `button-system.test.ts`: 3 expected failures on legacy hierarchy, missing semantic tokens, and missing loading/link APIs | `button-system.test.ts` + `design-tokens.test.ts`: 6/6 passed | all 7 workspaces exited 0 | Legacy button inputs remain private compatibility aliases until Tasks 32–35. |
| 2 | same commit | icon/workflow suites: 3 expected failures on missing governed-action names, semantic optical sizes, and status-specific mappings | `icon-registry.test.ts` + `workflow-status.test.ts`: 6/6 passed | all 7 workspaces exited 0 | Legacy icon sizes remain private aliases until Task 35. |
| 3 | same commit | contract suite rejected missing complete-snapshot enforcement; API suite failed on stored `inherit` rows and stale writes returning 200 | focused contract/API/web suites passed; broader policy/action regression: 15 files, 189 tests | all 7 workspaces exited 0 | Campaigns begin with seeded policy rows, so clients load the real non-null baseline. Corrected invalid API test commands in the remaining plan. |
| 4 | same commit | `scoped-action-policy.test.ts`: 3 expected failures on the missing editor, helpers, tightening choices, and conflict UI | `scoped-action-policy.test.ts` + `external-actions.test.ts`: 10/10 passed | all 7 workspaces exited 0 | Safety scopes expose only inherit/human-required and preserve attempted settings across a 409 until the current policy is explicitly reloaded. |
