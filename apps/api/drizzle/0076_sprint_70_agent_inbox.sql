CREATE TABLE `agent_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_run_id` text NOT NULL,
	`pipeline_run_id` text,
	`step_key` text,
	`type` text NOT NULL,
	`question` text NOT NULL,
	`why` text NOT NULL,
	`options_json` text,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_by_user_id` text,
	`answered_by_label` text,
	`answered_at` integer,
	`rule_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pipeline_run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`answered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rule_id`) REFERENCES `preference_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_questions_workspace_status` ON `agent_questions` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_questions_pipeline_run` ON `agent_questions` (`pipeline_run_id`);--> statement-breakpoint
CREATE INDEX `agent_questions_run` ON `agent_questions` (`agent_run_id`);