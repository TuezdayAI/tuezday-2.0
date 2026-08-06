ALTER TABLE `connections` ADD `timezone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `social_automation_settings` ADD `per_connection_reply_daily_cap` integer DEFAULT 10 NOT NULL;