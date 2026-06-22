CREATE TABLE `social_automation_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`kill_switch` integer DEFAULT 0 NOT NULL,
	`per_connection_daily_cap` integer DEFAULT 10 NOT NULL,
	`per_campaign_daily_cap` integer DEFAULT 5 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `automation_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `auto_daily_cap` integer;