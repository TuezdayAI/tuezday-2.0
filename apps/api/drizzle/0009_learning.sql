CREATE TABLE `engagement_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`draft_id` text,
	`channel` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`impressions` integer,
	`engagements` integer,
	`clicks` integer,
	`notes` text DEFAULT '' NOT NULL,
	`recorded_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `now_syntheses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`proposal` text NOT NULL,
	`rationale` text NOT NULL,
	`based_on_json` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
