UPDATE connections
SET
  status = 'error',
  last_error = 'reconnect_required',
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE provider_key = 'instagram'
AND COALESCE(json_extract(config_json, '$.authArchitecture'), '') <> 'instagram_login';
--> statement-breakpoint
UPDATE discovery_sources
SET
  status = 'error',
  last_error = 'reconnect_required',
  backoff_until = NULL
WHERE connection_id IN (
  SELECT id
  FROM connections
  WHERE provider_key = 'instagram'
  AND last_error = 'reconnect_required'
);
--> statement-breakpoint
UPDATE discovery_jobs
SET
  status = 'skipped',
  finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  error = 'reconnect_required',
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL
WHERE source_id IN (
  SELECT id FROM discovery_sources WHERE last_error = 'reconnect_required'
)
AND status IN ('queued', 'running');
