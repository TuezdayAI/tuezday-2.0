CREATE TABLE `campaign_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canonical_story_id` text,
	`manual_signal_id` text,
	`campaign_id` text NOT NULL,
	`plan_revision_id` text NOT NULL,
	`routing_profile_id` text NOT NULL,
	`status` text NOT NULL,
	`angle` text NOT NULL,
	`angle_hash` text NOT NULL,
	`workspace_relevance` integer NOT NULL,
	`campaign_fit` integer NOT NULL,
	`confidence` integer NOT NULL,
	`actionability` integer NOT NULL,
	`source_trust` integer NOT NULL,
	`suggested_persona_id` text,
	`supported_claims_json` text DEFAULT '[]' NOT NULL,
	`reason` text NOT NULL,
	`matcher_version` integer NOT NULL,
	`policy_json` text NOT NULL,
	`expires_at` integer,
	`decided_by_user_id` text,
	`decided_at` integer,
	`decision_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`manual_signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_revision_id`) REFERENCES `campaign_plan_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routing_profile_id`) REFERENCES `campaign_routing_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "campaign_opportunities_trigger_xor" CHECK(("campaign_opportunities"."canonical_story_id" IS NULL) <> ("campaign_opportunities"."manual_signal_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_opportunities_story_identity` ON `campaign_opportunities` (`canonical_story_id`,`campaign_id`,`plan_revision_id`,`angle_hash`,`matcher_version`) WHERE "campaign_opportunities"."canonical_story_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_opportunities_signal_identity` ON `campaign_opportunities` (`manual_signal_id`,`campaign_id`,`plan_revision_id`,`angle_hash`,`matcher_version`) WHERE "campaign_opportunities"."manual_signal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `campaign_opportunities_workspace_status` ON `campaign_opportunities` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `campaign_opportunities_story` ON `campaign_opportunities` (`canonical_story_id`);--> statement-breakpoint
CREATE INDEX `campaign_opportunities_campaign_status` ON `campaign_opportunities` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaign_opportunity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_user_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `campaign_opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_opportunity_events_opportunity` ON `campaign_opportunity_events` (`opportunity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaign_routing_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`plan_revision_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`profile_fingerprint` text NOT NULL,
	`routing_band` text NOT NULL,
	`min_fit` integer NOT NULL,
	`min_confidence` integer NOT NULL,
	`min_trust` integer NOT NULL,
	`compiler_version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_revision_id`) REFERENCES `campaign_plan_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_routing_profiles_identity` ON `campaign_routing_profiles` (`campaign_id`,`plan_revision_id`,`profile_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_routing_profiles_version` ON `campaign_routing_profiles` (`campaign_id`,`profile_version`);--> statement-breakpoint
CREATE INDEX `campaign_routing_profiles_workspace` ON `campaign_routing_profiles` (`workspace_id`,`campaign_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `routing_band` text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `routing_min_fit` integer DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `routing_min_confidence` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `routing_min_trust` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `routing_exclusions_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `canonical_external_stories` ADD `routing_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `canonical_external_stories` ADD `routing_fingerprint` text;--> statement-breakpoint
ALTER TABLE `canonical_external_stories` ADD `routing_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `canonical_external_stories` ADD `routing_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canonical_external_stories` ADD `routed_at` integer;--> statement-breakpoint
CREATE INDEX `canonical_stories_routing_queue` ON `canonical_external_stories` (`workspace_id`,`routing_state`,`routing_lease_expires_at`);