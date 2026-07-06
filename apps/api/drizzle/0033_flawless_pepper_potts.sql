CREATE TABLE `discovery_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `discovery_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discovery_jobs_workspace_status` ON `discovery_jobs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `discovery_jobs_source_status` ON `discovery_jobs` (`source_id`,`status`);--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `cursor_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `backoff_until` integer;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `last_attempted_at` integer;