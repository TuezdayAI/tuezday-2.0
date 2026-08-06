CREATE TABLE `content_package_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`package_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_user_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_package_events_package` ON `content_package_events` (`package_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`plan_revision_id` text NOT NULL,
	`opportunity_id` text,
	`canonical_story_id` text,
	`angle` text NOT NULL,
	`angle_hash` text NOT NULL,
	`novelty` integer NOT NULL,
	`status` text DEFAULT 'assessing' NOT NULL,
	`assessment_state` text DEFAULT 'pending' NOT NULL,
	`assessment_attempts` integer DEFAULT 0 NOT NULL,
	`assessment_lease_expires_at` integer,
	`assessed_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_revision_id`) REFERENCES `campaign_plan_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `campaign_opportunities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`canonical_story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_packages_opportunity` ON `content_packages` (`opportunity_id`) WHERE "content_packages"."opportunity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `content_packages_workspace_status` ON `content_packages` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_packages_campaign_status` ON `content_packages` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `content_packages_campaign_angle` ON `content_packages` (`campaign_id`,`angle_hash`);--> statement-breakpoint
CREATE INDEX `content_packages_assessment_queue` ON `content_packages` (`workspace_id`,`assessment_state`,`assessment_lease_expires_at`);--> statement-breakpoint
CREATE TABLE `lane_eligibility_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`package_id` text NOT NULL,
	`assessment_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`lane_revision_id` text NOT NULL,
	`eligible` integer NOT NULL,
	`checks_json` text NOT NULL,
	`evaluator_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assessment_id`) REFERENCES `sufficiency_assessments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `campaign_lanes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_revision_id`) REFERENCES `campaign_lane_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lane_eligibility_identity` ON `lane_eligibility_decisions` (`package_id`,`assessment_id`,`lane_revision_id`);--> statement-breakpoint
CREATE INDEX `lane_eligibility_package` ON `lane_eligibility_decisions` (`package_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`package_id` text NOT NULL,
	`role` text NOT NULL,
	`canonical_story_id` text,
	`occurrence_id` text,
	`signal_id` text,
	`title` text DEFAULT '' NOT NULL,
	`url` text,
	`excerpt` text DEFAULT '' NOT NULL,
	`snapshot_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`occurrence_id`) REFERENCES `discovery_source_occurrences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `package_sources_package` ON `package_sources` (`package_id`);--> statement-breakpoint
CREATE TABLE `sufficiency_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`package_id` text NOT NULL,
	`assessment_version` integer NOT NULL,
	`verdict` text NOT NULL,
	`confidence` integer NOT NULL,
	`supported_claims_json` text DEFAULT '[]' NOT NULL,
	`missing_facts_json` text DEFAULT '[]' NOT NULL,
	`missing_media_json` text DEFAULT '[]' NOT NULL,
	`eligible_formats_json` text DEFAULT '[]' NOT NULL,
	`ineligible_formats_json` text DEFAULT '[]' NOT NULL,
	`research_actions_json` text DEFAULT '[]' NOT NULL,
	`assessor_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_id`) REFERENCES `content_packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sufficiency_assessments_version` ON `sufficiency_assessments` (`package_id`,`assessment_version`);--> statement-breakpoint
CREATE INDEX `sufficiency_assessments_package` ON `sufficiency_assessments` (`package_id`,`created_at`);