CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`objective` text DEFAULT '' NOT NULL,
	`kpi` text DEFAULT '' NOT NULL,
	`timeframe` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`pillars_json` text DEFAULT '[]' NOT NULL,
	`channels_json` text DEFAULT '[]' NOT NULL,
	`persona_ids_json` text DEFAULT '[]' NOT NULL,
	`overlay` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `drafts` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `campaign_id` text;