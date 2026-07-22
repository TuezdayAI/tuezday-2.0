CREATE TABLE `campaign_lane_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`plan_revision_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`audience_id` text,
	`channel` text NOT NULL,
	`format` text NOT NULL,
	`publishing_connection_id` text,
	`provider_target` text DEFAULT '' NOT NULL,
	`delivery_mode` text NOT NULL,
	`planned_quantity` integer DEFAULT 0 NOT NULL,
	`schedule_json` text,
	`reactive_period` text,
	`reactive_cap` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `campaign_lanes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_revision_id`) REFERENCES `campaign_plan_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`audience_id`) REFERENCES `audiences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`publishing_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_lane_plan_revision` ON `campaign_lane_revisions` (`lane_id`,`plan_revision_id`);--> statement-breakpoint
CREATE INDEX `campaign_lane_revision_plan` ON `campaign_lane_revisions` (`plan_revision_id`);--> statement-breakpoint
CREATE TABLE `campaign_lanes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_lane_key` ON `campaign_lanes` (`campaign_id`,`key`);--> statement-breakpoint
CREATE INDEX `campaign_lane_workspace_campaign` ON `campaign_lanes` (`workspace_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaign_plan_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`objective` text DEFAULT '' NOT NULL,
	`kpi` text DEFAULT '' NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`audience_ids_json` text DEFAULT '[]' NOT NULL,
	`pillars_json` text DEFAULT '[]' NOT NULL,
	`offers_json` text DEFAULT '[]' NOT NULL,
	`ctas_json` text DEFAULT '[]' NOT NULL,
	`guidance` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_plan_revision_number` ON `campaign_plan_revisions` (`campaign_id`,`revision`);--> statement-breakpoint
CREATE INDEX `campaign_plan_workspace_campaign` ON `campaign_plan_revisions` (`workspace_id`,`campaign_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `purpose` text DEFAULT 'initiative' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `current_plan_revision_id` text;