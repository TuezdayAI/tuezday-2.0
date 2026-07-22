CREATE TABLE `external_action_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`action_id` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`actor_user_id` text,
	`actor_label` text NOT NULL,
	`subject_fingerprint` text NOT NULL,
	`policy_snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `external_actions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `external_action_decisions_action` ON `external_action_decisions` (`action_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `external_action_decisions_workspace` ON `external_action_decisions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `external_action_policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`action_kind` text NOT NULL,
	`rule` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_action_policy_scope_kind` ON `external_action_policy_rules` (`workspace_id`,`scope`,`scope_id`,`action_kind`);--> statement-breakpoint
CREATE INDEX `external_action_policy_workspace_scope` ON `external_action_policy_rules` (`workspace_id`,`scope`,`scope_id`);--> statement-breakpoint
CREATE TABLE `external_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`draft_id` text,
	`campaign_id` text,
	`persona_id` text,
	`connection_id` text,
	`lane_revision_id` text,
	`payload_json` text NOT NULL,
	`subject_snapshot_json` text NOT NULL,
	`requested_for` integer,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`policy_snapshot_json` text NOT NULL,
	`blocker_code` text,
	`blocker_detail` text,
	`blocker_retryable` integer,
	`supersedes_action_id` text,
	`superseded_by_action_id` text,
	`execution_kind` text,
	`execution_id` text,
	`execution_receipt_json` text,
	`proposed_by_user_id` text,
	`proposed_by_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`authorized_at` integer,
	`dispatched_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lane_revision_id`) REFERENCES `campaign_lane_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proposed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_actions_workspace_idempotency` ON `external_actions` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `external_actions_workspace_status` ON `external_actions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `external_actions_workspace_subject` ON `external_actions` (`workspace_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `external_actions_campaign` ON `external_actions` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `ad_launches` ADD `external_action_id` text REFERENCES external_actions(id);--> statement-breakpoint
CREATE INDEX `ad_launches_external_action` ON `ad_launches` (`external_action_id`);--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `external_action_id` text REFERENCES external_actions(id);--> statement-breakpoint
CREATE INDEX `inbox_items_external_action` ON `inbox_items` (`external_action_id`);--> statement-breakpoint
ALTER TABLE `launch_messages` ADD `external_action_id` text REFERENCES external_actions(id);--> statement-breakpoint
CREATE INDEX `launch_messages_external_action` ON `launch_messages` (`external_action_id`);--> statement-breakpoint
ALTER TABLE `publications` ADD `external_action_id` text REFERENCES external_actions(id);--> statement-breakpoint
CREATE INDEX `publications_external_action` ON `publications` (`external_action_id`);