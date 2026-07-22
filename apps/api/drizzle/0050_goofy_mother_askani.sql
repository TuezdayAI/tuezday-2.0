CREATE TABLE `workspace_compliance` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`postal_address` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `outreach_enrollments` ADD `last_reply_handled_at` integer;