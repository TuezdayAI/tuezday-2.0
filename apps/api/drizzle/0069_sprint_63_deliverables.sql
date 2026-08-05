CREATE TABLE `context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`deliverable_id` text NOT NULL,
	`package_id` text,
	`resolved_context_json` text NOT NULL,
	`inputs_json` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deliverable_id`) REFERENCES `deliverables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `context_snapshots_deliverable` ON `context_snapshots` (`deliverable_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliverable_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`deliverable_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_user_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deliverable_id`) REFERENCES `deliverables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliverable_events_deliverable` ON `deliverable_events` (`deliverable_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliverables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`plan_revision_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`lane_revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`original_scheduled_for` integer,
	`package_id` text,
	`angle` text DEFAULT '' NOT NULL,
	`angle_hash` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`generation_state` text DEFAULT 'pending' NOT NULL,
	`generation_attempts` integer DEFAULT 0 NOT NULL,
	`generation_lease_expires_at` integer,
	`generated_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_revision_id`) REFERENCES `campaign_plan_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `campaign_lanes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_revision_id`) REFERENCES `campaign_lane_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliverables_planned_slot` ON `deliverables` (`lane_revision_id`,`original_scheduled_for`) WHERE "deliverables"."original_scheduled_for" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `deliverables_reactive_package` ON `deliverables` (`package_id`,`lane_revision_id`) WHERE "deliverables"."kind" = 'reactive' AND "deliverables"."package_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `deliverables_workspace_status` ON `deliverables` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `deliverables_lane_revision` ON `deliverables` (`lane_revision_id`,`status`);--> statement-breakpoint
CREATE INDEX `deliverables_package` ON `deliverables` (`package_id`);--> statement-breakpoint
CREATE INDEX `deliverables_campaign_status` ON `deliverables` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `deliverables_generation_queue` ON `deliverables` (`workspace_id`,`generation_state`,`generation_lease_expires_at`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`deliverable_id` text NOT NULL,
	`variant_version` integer NOT NULL,
	`context_snapshot_id` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_by_user_id` text,
	`selected_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deliverable_id`) REFERENCES `deliverables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_snapshot_id`) REFERENCES `context_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_version` ON `variants` (`deliverable_id`,`variant_version`);--> statement-breakpoint
CREATE INDEX `variants_deliverable_status` ON `variants` (`deliverable_id`,`status`);--> statement-breakpoint
ALTER TABLE `content_packages` ADD `fanned_out_at` integer;