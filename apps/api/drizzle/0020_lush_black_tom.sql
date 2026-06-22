CREATE TABLE `posting_cadences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`campaign_id` text,
	`persona_id` text,
	`channel` text NOT NULL,
	`connection_id` text NOT NULL,
	`target` text NOT NULL,
	`days_of_week_json` text NOT NULL,
	`time_of_day` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `publications` ADD `cadence_id` text REFERENCES posting_cadences(id) ON DELETE set null;