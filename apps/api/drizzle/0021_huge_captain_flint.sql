CREATE TABLE `audience_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `audiences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_members_unique` ON `audience_members` (`audience_id`,`member_type`,`member_id`);--> statement-breakpoint
CREATE TABLE `audiences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`rules_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `campaign_audiences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `audiences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_audiences_unique` ON `campaign_audiences` (`campaign_id`,`audience_id`);--> statement-breakpoint
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
CREATE TABLE `launch_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`launch_id` text NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`recipient_type` text,
	`recipient_id` text,
	`recipient_name` text DEFAULT '' NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`recipient_handle` text,
	`draft_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`skip_reason` text,
	`external_id` text,
	`external_url` text,
	`publication_id` text,
	`sent_at` integer,
	`last_error` text,
	`step_number` integer DEFAULT 1 NOT NULL,
	`sequence_recipient_id` text,
	`connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sequence_recipient_id`) REFERENCES `sequence_recipients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `launches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`audience_id` text,
	`campaign_id` text,
	`persona_id` text,
	`channels_json` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`automation_mode` text DEFAULT 'manual' NOT NULL,
	`stop_on_reply` integer DEFAULT 1 NOT NULL,
	`x_connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `audiences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`x_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `posting_cadences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`campaign_id` text,
	`persona_id` text,
	`channel` text NOT NULL,
	`connection_id` text NOT NULL,
	`target` text NOT NULL,
	`days_of_week_json` text NOT NULL,
	`time_of_day` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `sequence_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`launch_id` text NOT NULL,
	`channel` text NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_name` text DEFAULT '' NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`recipient_handle` text,
	`current_step` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_due_at` integer,
	`last_sent_at` integer,
	`stopped_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_recipients_unique` ON `sequence_recipients` (`launch_id`,`channel`,`recipient_type`,`recipient_id`);--> statement-breakpoint
CREATE TABLE `sequence_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`launch_id` text NOT NULL,
	`channel` text NOT NULL,
	`step_number` integer NOT NULL,
	`instruction` text DEFAULT '' NOT NULL,
	`delay_hours` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_steps_launch_channel_step` ON `sequence_steps` (`launch_id`,`channel`,`step_number`);--> statement-breakpoint
CREATE TABLE `social_automation_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`kill_switch` integer DEFAULT 0 NOT NULL,
	`per_connection_daily_cap` integer DEFAULT 10 NOT NULL,
	`per_campaign_daily_cap` integer DEFAULT 5 NOT NULL,
	`auto_reply_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `automation_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `auto_daily_cap` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `x_handle` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `publications` ADD `media_json` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `cadence_id` text REFERENCES posting_cadences(id);