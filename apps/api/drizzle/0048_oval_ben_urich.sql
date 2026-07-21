CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider` text DEFAULT 'gmail' NOT NULL,
	`address` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`reply_to` text,
	`signature` text DEFAULT '' NOT NULL,
	`daily_cap` integer DEFAULT 50 NOT NULL,
	`sending_window_json` text DEFAULT '{}' NOT NULL,
	`default_persona_id` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`last_polled_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_workspace_address` ON `mailboxes` (`workspace_id`,`address`);--> statement-breakpoint
CREATE INDEX `mailboxes_workspace_status` ON `mailboxes` (`workspace_id`,`status`);--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `provider_thread_id` text;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `mailbox_id` text REFERENCES mailboxes(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `email_delivery_id` text REFERENCES email_deliveries(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `reply_label` text;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `reply_labeled_at` integer;