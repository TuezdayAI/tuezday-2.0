CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`value` integer NOT NULL,
	`window` text NOT NULL,
	`period_start` integer NOT NULL,
	`source` text NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_grain` ON `metrics` (`workspace_id`,`subject_type`,`subject_id`,`metric_key`,`window`,`period_start`);--> statement-breakpoint
CREATE INDEX `metrics_workspace_subject` ON `metrics` (`workspace_id`,`subject_type`,`subject_id`);