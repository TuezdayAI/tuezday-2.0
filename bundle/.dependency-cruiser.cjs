/**
 * Architectural boundaries from AGENTS.md §2 and §7, enforced.
 * `npm run graph:check` fails the build on any violation.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are the first sign of design decay.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'web-must-not-import-api-internals',
      severity: 'error',
      comment: 'apps/web talks to the API over HTTP. Share types via packages/contracts only.',
      from: { path: '^apps/web' },
      to: { path: '^apps/(api|worker)/src' },
    },
    {
      name: 'worker-must-not-touch-db',
      severity: 'error',
      comment: 'The worker calls the API. The API owns database access.',
      from: { path: '^apps/worker' },
      to: { path: '^apps/api/src/db' },
    },
    {
      name: 'routes-must-not-touch-db',
      severity: 'error',
      comment: 'Routes are thin: validate, then call a service.',
      from: { path: '^apps/api/src/routes' },
      to: { path: '^apps/api/src/db' },
    },
    {
      name: 'services-must-not-import-providers',
      severity: 'error',
      comment: 'Services depend on interfaces, never on gemini/nango/resend implementations.',
      from: { path: '^apps/api/src/services' },
      to: { path: '^apps/api/src/(llm/gemini|connectors/nango|evidence/db-store|mail/resend)' },
    },
    {
      name: 'contracts-must-stay-leaf',
      severity: 'error',
      comment: 'packages/contracts is imported by everyone and imports nothing of ours.',
      from: { path: '^packages/contracts' },
      to: { path: '^(apps|packages/brain)' },
    },
    {
      name: 'no-send-path-through-exporter',
      severity: 'error',
      comment: 'OutboundExporter is a manual CSV export, not a send path (AGENTS.md §2).',
      from: { path: '^apps/api/src/(outbound/(send|dispatch)|services/.*send)' },
      to: { path: 'outbound/exporter' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)vitest\\.config\\.ts$', '(^|/)[.][^/]+[.](js|cjs|mjs|ts)$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.next|drizzle)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
