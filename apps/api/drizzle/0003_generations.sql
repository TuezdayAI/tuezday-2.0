CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_type` text NOT NULL,
	`channel` text NOT NULL,
	`persona_id` text,
	`prompt` text NOT NULL,
	`sections_json` text NOT NULL,
	`output` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`rating` text,
	`rated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
