CREATE TABLE `chat_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text,
	`agent_run_id` text,
	`tool` text NOT NULL,
	`args_json` text NOT NULL,
	`intent_json` text NOT NULL,
	`status` text NOT NULL,
	`quarantined` integer DEFAULT false NOT NULL,
	`quarantine_reason` text,
	`produced_ref` text,
	`produced_status` text,
	`error` text,
	`error_message` text,
	`confirmed_by_user_id` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_proposals_session_created` ON `chat_proposals` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_proposals_workspace_created` ON `chat_proposals` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD `chat_session_id` text;--> statement-breakpoint
ALTER TABLE `external_actions` ADD `origin_surface` text;