ALTER TABLE `chat_messages` ADD `agent_run_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `cost_cents` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `goal` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `campaign_id` text REFERENCES campaigns(id);--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `persona_id` text REFERENCES personas(id);--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `channel` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `total_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `total_output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `total_cost_cents` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `compacted_through_message_id` text;