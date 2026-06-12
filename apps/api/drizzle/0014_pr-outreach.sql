CREATE TABLE `media_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`type` text DEFAULT 'journalist' NOT NULL,
	`outlet` text DEFAULT '' NOT NULL,
	`beat` text DEFAULT '' NOT NULL,
	`coverage_notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `drafts` ADD `media_contact_id` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `media_contact_id` text;