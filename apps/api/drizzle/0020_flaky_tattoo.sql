CREATE TABLE `generation_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`review_enabled` integer DEFAULT 1 NOT NULL,
	`angle_enabled` integer DEFAULT 0 NOT NULL,
	`angle_count` integer DEFAULT 3 NOT NULL,
	`flag_threshold` integer DEFAULT 70 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `drafts` ADD `review_json` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `review_json` text;