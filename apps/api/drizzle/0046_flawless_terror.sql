CREATE TABLE `external_action_batch_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`action_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`status` text NOT NULL,
	`submission_json` text,
	`error` text,
	`processed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `external_action_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `external_actions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_action_batch_items_batch_action` ON `external_action_batch_items` (`batch_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `external_action_batch_items_workspace_batch` ON `external_action_batch_items` (`workspace_id`,`batch_id`);--> statement-breakpoint
CREATE TABLE `external_action_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_id` text NOT NULL,
	`selection_json` text NOT NULL,
	`status` text NOT NULL,
	`continuation_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_by_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_action_batches_workspace_request` ON `external_action_batches` (`workspace_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `external_action_batches_workspace_status` ON `external_action_batches` (`workspace_id`,`status`);