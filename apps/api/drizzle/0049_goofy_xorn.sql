CREATE TABLE `outreach_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`mailbox_id` text,
	`last_thread_id` text,
	`current_step` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_due_at` integer,
	`last_sent_at` integer,
	`stopped_reason` text,
	`enrolled_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_id`) REFERENCES `outreach_sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_enrollments_sequence_recipient` ON `outreach_enrollments` (`sequence_id`,`recipient_type`,`recipient_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_enrollments_active_person` ON `outreach_enrollments` (`workspace_id`,`recipient_type`,`recipient_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `outreach_enrollments_due` ON `outreach_enrollments` (`status`,`next_due_at`);--> statement-breakpoint
CREATE TABLE `outreach_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`draft_id` text,
	`external_action_id` text,
	`provider_thread_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`sent_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `outreach_enrollments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`external_action_id`) REFERENCES `external_actions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_messages_enrollment_step` ON `outreach_messages` (`enrollment_id`,`step_number`);--> statement-breakpoint
CREATE TABLE `outreach_sequence_mailboxes` (
	`sequence_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	PRIMARY KEY(`sequence_id`, `mailbox_id`),
	FOREIGN KEY (`sequence_id`) REFERENCES `outreach_sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outreach_sequence_mailboxes_mailbox` ON `outreach_sequence_mailboxes` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `outreach_sequence_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`instruction` text DEFAULT '' NOT NULL,
	`delay_hours` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_id`) REFERENCES `outreach_sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_steps_sequence_number` ON `outreach_sequence_steps` (`sequence_id`,`step_number`);--> statement-breakpoint
CREATE TABLE `outreach_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`persona_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`automation_mode` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`daily_enrollment_cap` integer DEFAULT 50 NOT NULL,
	`stop_on_reply` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `audiences`(`id`) ON UPDATE no action ON DELETE cascade
);
