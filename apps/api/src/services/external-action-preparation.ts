/**
 * Raised when an external action's intent cannot be (re)built from the current
 * world — the draft left `approved`, the connection was deleted, the persona is
 * no longer routed to the account.
 *
 * It lives in its own module rather than in `external-action-adapters.ts` so
 * the coordinator can recognise it during revalidation without importing the
 * whole adapter surface (connectors, ads, inbox, launches) at runtime.
 * `external-action-adapters.ts` re-exports it, so existing importers are
 * unaffected.
 */
export class ExternalActionPreparationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: 400 | 404 | 409,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExternalActionPreparationError";
  }
}
