CREATE TABLE `eval_case_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`pipeline_run_id` text,
	`produced_content` text,
	`checks_json` text DEFAULT '[]' NOT NULL,
	`judge_json` text,
	`verdict` text,
	`edit_distance_to_final` real,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `eval_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pipeline_run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `eval_case_results_run` ON `eval_case_results` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`signal_id` text,
	`signal_content` text NOT NULL,
	`signal_source` text NOT NULL,
	`channel` text NOT NULL,
	`campaign_id` text,
	`persona_id` text,
	`source_draft_id` text,
	`generated_content` text NOT NULL,
	`final_content` text NOT NULL,
	`outcome` text NOT NULL,
	`rejection_reason` text,
	`decided_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `eval_suites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `eval_cases_suite` ON `eval_cases` (`suite_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`definition_id` text,
	`definition_version` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`judge_enabled` integer DEFAULT false NOT NULL,
	`metrics_json` text NOT NULL,
	`baseline_label` text,
	`failure_reason` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suite_id`) REFERENCES `eval_suites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `pipeline_definitions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_runs_baseline_label` ON `eval_runs` (`workspace_id`,`baseline_label`) WHERE "eval_runs"."baseline_label" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `eval_runs_workspace` ON `eval_runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`task_key` text NOT NULL,
	`channel` text NOT NULL,
	`cta_expectation` text DEFAULT 'any' NOT NULL,
	`case_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `eval_suites_workspace` ON `eval_suites` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_banned_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`phrase` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_banned_claims_phrase` ON `workspace_banned_claims` (`workspace_id`,`phrase`);