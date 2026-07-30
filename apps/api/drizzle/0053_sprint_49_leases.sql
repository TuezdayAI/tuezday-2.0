CREATE TABLE `task_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `discovery_jobs` ADD `source_execution_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_jobs` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `discovery_jobs` ADD `lease_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_jobs` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `discovery_jobs` ADD `heartbeat_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `discovery_jobs_one_active_source` ON `discovery_jobs` (`source_id`) WHERE "discovery_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `execution_version` integer DEFAULT 1 NOT NULL;