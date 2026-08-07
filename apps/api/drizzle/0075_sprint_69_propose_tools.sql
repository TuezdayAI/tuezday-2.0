CREATE TABLE `agent_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_run_id` text NOT NULL,
	`tool` text NOT NULL,
	`target_kind` text NOT NULL,
	`draft_id` text,
	`external_action_id` text,
	`summary` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`external_action_id`) REFERENCES `external_actions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_proposals_workspace_created` ON `agent_proposals` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_proposals_run` ON `agent_proposals` (`agent_run_id`);--> statement-breakpoint
ALTER TABLE `external_actions` ADD `origin` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_actions` ADD `origin_run_id` text;--> statement-breakpoint
-- Sprint 69 (D-69.4): honest backfill. Every pre-existing action was proposed
-- by a person through a route or by the platform's own loops; the two are told
-- apart by whether a user id was attributed at proposal time. The column
-- default ('human') is right for new human-originated rows and wrong for these,
-- so the system ones are corrected here rather than left to read as human.
UPDATE `external_actions` SET `origin` = 'system' WHERE `proposed_by_user_id` IS NULL;
