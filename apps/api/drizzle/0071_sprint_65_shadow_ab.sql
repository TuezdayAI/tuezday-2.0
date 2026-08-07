CREATE TABLE `pipeline_rollout_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_key` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text NOT NULL,
	`metrics_json` text NOT NULL,
	`decided_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pipeline_rollout_decisions_workspace` ON `pipeline_rollout_decisions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pipeline_shadow_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`pair_key` text NOT NULL,
	`signal_id` text,
	`campaign_id` text,
	`channel` text NOT NULL,
	`draft_id` text,
	`run_id` text NOT NULL,
	`verdict` text,
	`verdict_notes` text DEFAULT '' NOT NULL,
	`verdict_by_user_id` text,
	`verdict_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verdict_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_shadow_pairs_key` ON `pipeline_shadow_pairs` (`pair_key`);--> statement-breakpoint
CREATE INDEX `pipeline_shadow_pairs_workspace` ON `pipeline_shadow_pairs` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `social_automation_settings` ADD `generation_path` text DEFAULT 'legacy' NOT NULL;