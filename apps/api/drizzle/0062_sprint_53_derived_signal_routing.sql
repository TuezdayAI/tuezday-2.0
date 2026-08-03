-- Sprint 53 (decision D3b): retire the second signal->routing mapping.
--
-- `signals.suggested_persona_id` / `.suggested_campaign_id` and the same pair on
-- `discovered_items` are no longer stored. Every read derives them in memory from
-- the top-scoring `signal_matches` / `discovered_item_matches` row
-- (`projectSuggestedRouting` in services/matching.ts), and no code writes a
-- non-null value into them any more. Null the leftovers so the dead mapping
-- cannot resurface behind the projection.
--
-- The columns themselves stay: SQLite `DROP COLUMN` forces a full table recreate,
-- which this codebase deliberately avoids (see the `currentPlanRevisionId`
-- comment in db/schema.ts). Neither column has an FK or an index, so nulling
-- costs nothing structurally. Physical removal is a follow-up sprint.
--
-- Idempotent: a re-run matches zero rows. Size-independent: two set-based
-- UPDATEs, no per-row work and no temporary tables.
UPDATE signals
SET
  suggested_persona_id = NULL,
  suggested_campaign_id = NULL
WHERE suggested_persona_id IS NOT NULL
   OR suggested_campaign_id IS NOT NULL;
--> statement-breakpoint
UPDATE discovered_items
SET
  suggested_persona_id = NULL,
  suggested_campaign_id = NULL
WHERE suggested_persona_id IS NOT NULL
   OR suggested_campaign_id IS NOT NULL;
