CREATE TABLE `design_overlays` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`design_system_id` text NOT NULL,
	`channel` text NOT NULL,
	`persona_id` text,
	`campaign_id` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`design_system_id`) REFERENCES `design_systems`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_overlays_system_channel_scope` ON `design_overlays` (`design_system_id`,`channel`,`persona_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `design_systems` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text DEFAULT 'Default' NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_systems_workspace_name` ON `design_systems` (`workspace_id`,`name`);