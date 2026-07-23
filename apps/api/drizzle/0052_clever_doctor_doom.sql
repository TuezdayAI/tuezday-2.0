CREATE TABLE `outreach_tracking_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email_delivery_id` text,
	`type` text NOT NULL,
	`target_url` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`email_delivery_id`) REFERENCES `email_deliveries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `outreach_tracking_events_delivery` ON `outreach_tracking_events` (`email_delivery_id`);--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `opened_at` integer;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `open_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `first_click_at` integer;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `click_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outreach_enrollments` ADD `outcome` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `outreach_sequences` ADD `track_opens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outreach_sequences` ADD `track_clicks` integer DEFAULT 0 NOT NULL;