CREATE TABLE `draft_revision_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`actor_id` text,
	`instruction` text NOT NULL,
	`source_content` text NOT NULL,
	`result_content` text,
	`sections_json` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`model` text,
	`provider` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_revision_turn_request` ON `draft_revision_turns` (`draft_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `draft_revision_turn_draft` ON `draft_revision_turns` (`draft_id`,`created_at`);