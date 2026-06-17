CREATE TABLE `guidance_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guidance_overrides_workspace_channel` ON `guidance_overrides` (`workspace_id`,`channel`);