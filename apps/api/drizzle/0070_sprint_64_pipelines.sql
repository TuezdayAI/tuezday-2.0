CREATE TABLE `pipeline_definition_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`version` integer NOT NULL,
	`spec_json` text NOT NULL,
	`actor_label` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `pipeline_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_definition_versions_version` ON `pipeline_definition_versions` (`definition_id`,`version`);--> statement-breakpoint
CREATE TABLE `pipeline_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`campaign_id` text,
	`lane_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`spec_json` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lane_id`) REFERENCES `campaign_lanes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pipeline_definitions_workspace_task` ON `pipeline_definitions` (`workspace_id`,`task_key`,`status`);--> statement-breakpoint
CREATE TABLE `pipeline_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_key` text NOT NULL,
	`iteration` integer DEFAULT 1 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`agent_run_id` text,
	`output_json` text,
	`passes` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`stop_reason` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_run_steps_attempt` ON `pipeline_run_steps` (`run_id`,`step_key`,`iteration`,`attempt`);--> statement-breakpoint
CREATE INDEX `pipeline_run_steps_run` ON `pipeline_run_steps` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`definition_version` integer NOT NULL,
	`task_key` text NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`dry_run_batch_id` text,
	`signal_id` text,
	`campaign_id` text,
	`lane_id` text,
	`persona_id` text,
	`channel` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`paused_at_step_key` text,
	`escalation_reason` text,
	`failure_reason` text,
	`checklist_json` text DEFAULT '[]' NOT NULL,
	`result_json` text,
	`generation_id` text,
	`draft_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `pipeline_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lane_id`) REFERENCES `campaign_lanes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_runs_idempotency` ON `pipeline_runs` (`workspace_id`,`idempotency_key`) WHERE "pipeline_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pipeline_runs_workspace_status` ON `pipeline_runs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pipeline_runs_definition` ON `pipeline_runs` (`definition_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pipeline_runs_batch` ON `pipeline_runs` (`dry_run_batch_id`);