CREATE TABLE `discovered_item_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`item_id` text NOT NULL,
	`persona_id` text,
	`campaign_id` text,
	`score` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `discovered_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discovered_item_matches_item` ON `discovered_item_matches` (`item_id`);--> statement-breakpoint
CREATE TABLE `signal_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`signal_id` text NOT NULL,
	`persona_id` text,
	`campaign_id` text,
	`score` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signal_matches_signal` ON `signal_matches` (`signal_id`);--> statement-breakpoint
CREATE INDEX `signal_matches_signal_campaign` ON `signal_matches` (`signal_id`,`campaign_id`);--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `scored_at` integer;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `url_hash` text;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `content_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `duplicate_of_id` text;--> statement-breakpoint
CREATE INDEX `discovered_items_workspace_url_hash` ON `discovered_items` (`workspace_id`,`url_hash`);--> statement-breakpoint
CREATE INDEX `discovered_items_workspace_content_hash` ON `discovered_items` (`workspace_id`,`content_hash`);--> statement-breakpoint
ALTER TABLE `social_automation_settings` ADD `match_threshold` integer DEFAULT 50 NOT NULL;