CREATE TABLE `chat_pins` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_pins_session` ON `chat_pins` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_pins_session_kind_ref` ON `chat_pins` (`session_id`,`kind`,`ref_id`);--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD `campaign_id` text REFERENCES campaigns(id);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `cards_json` text DEFAULT '[]' NOT NULL;