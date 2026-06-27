CREATE TABLE `crm_sync_settings` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`filter_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `crm_contacts` ADD `discarded_at` integer;