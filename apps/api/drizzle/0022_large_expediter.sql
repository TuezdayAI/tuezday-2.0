CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`parent_external_id` text,
	`publication_id` text,
	`launch_message_id` text,
	`author_handle` text DEFAULT '' NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`url` text,
	`status` text DEFAULT 'unread' NOT NULL,
	`reply_draft_id` text,
	`posted_reply_external_id` text,
	`posted_reply_url` text,
	`external_created_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`launch_message_id`) REFERENCES `launch_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reply_draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_connection_external` ON `inbox_items` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `publication_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`window` text NOT NULL,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`impressions` integer,
	`clicks` integer,
	`captured_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_metrics_pub_window` ON `publication_metrics` (`publication_id`,`window`);--> statement-breakpoint
ALTER TABLE `social_automation_settings` ADD `auto_reply_enabled` integer DEFAULT 0 NOT NULL;