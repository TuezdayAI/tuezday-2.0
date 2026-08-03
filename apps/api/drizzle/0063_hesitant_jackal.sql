CREATE TABLE `llm_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`pipeline` text NOT NULL,
	`campaign_id` text,
	`agent_run_id` text,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_usage_events_workspace_created` ON `llm_usage_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `llm_usage_events_workspace_pipeline` ON `llm_usage_events` (`workspace_id`,`pipeline`,`created_at`);