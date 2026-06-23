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
ALTER TABLE `launch_messages` ADD `step_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `launch_messages` ADD `sequence_recipient_id` text REFERENCES sequence_recipients(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `launch_messages` ADD `connection_id` text REFERENCES connections(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `launches` ADD `automation_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `launches` ADD `stop_on_reply` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `launches` ADD `x_connection_id` text REFERENCES connections(id) ON DELETE set null;