CREATE TABLE `preference_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`draft_id` text,
	`task_type` text NOT NULL,
	`channel` text NOT NULL,
	`before_content` text NOT NULL,
	`after_content` text NOT NULL,
	`instruction` text,
	`edit_distance` real DEFAULT 0 NOT NULL,
	`digested_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preference_edit_source` ON `preference_edits` (`workspace_id`,`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `preference_edit_undigested` ON `preference_edits` (`workspace_id`,`digested_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `preference_rule_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`edit_id` text NOT NULL,
	`excerpt` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `preference_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edit_id`) REFERENCES `preference_edits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preference_rule_evidence_pair` ON `preference_rule_evidence` (`rule_id`,`edit_id`);--> statement-breakpoint
CREATE TABLE `preference_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`rule` text NOT NULL,
	`polarity` text NOT NULL,
	`scope_task_type` text,
	`scope_channel` text,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`observation_count` integer DEFAULT 0 NOT NULL,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`last_observed_at` integer,
	`last_applied_at` integer,
	`promoted_at` integer,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `preference_rule_workspace` ON `preference_rules` (`workspace_id`,`status`,`confidence`);