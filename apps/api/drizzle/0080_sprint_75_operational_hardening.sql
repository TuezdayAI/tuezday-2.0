ALTER TABLE `connections` ADD `timezone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `publications` ADD `provider_operation_id` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `publications` ADD `processing_started_at` integer;--> statement-breakpoint
ALTER TABLE `publications` ADD `processing_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `social_automation_settings` ADD `per_connection_reply_daily_cap` integer DEFAULT 10 NOT NULL;