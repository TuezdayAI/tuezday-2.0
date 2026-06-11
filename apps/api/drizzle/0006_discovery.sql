CREATE TABLE `discovered_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`published_at` integer,
	`score` integer,
	`suggested_persona_id` text,
	`score_reason` text,
	`status` text DEFAULT 'new' NOT NULL,
	`signal_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `discovery_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discovered_items_source_external` ON `discovered_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `discovery_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text NOT NULL,
	`last_error` text,
	`last_fetched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
