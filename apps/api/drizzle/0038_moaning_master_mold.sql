CREATE TABLE `design_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`design_system_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`design_system_fingerprint` text NOT NULL,
	`slide_shape` text NOT NULL,
	`html` text NOT NULL,
	`css` text NOT NULL,
	`placeholders_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`design_system_id`) REFERENCES `design_systems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_templates_lookup` ON `design_templates` (`workspace_id`,`design_system_id`,`skill_id`,`design_system_fingerprint`,`slide_shape`);