UPDATE discovery_jobs
SET
  status = 'skipped',
  finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  error = 'source_reserved',
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL
WHERE source_id IN (
  SELECT id
  FROM discovery_sources
  WHERE type IN ('g2', 'capterra', 'intent')
)
AND status IN ('queued', 'running');
--> statement-breakpoint
UPDATE discovery_sources
SET
  status = 'reserved',
  enabled = 0,
  last_error = 'source_reserved',
  backoff_until = NULL
WHERE type IN ('g2', 'capterra', 'intent');
