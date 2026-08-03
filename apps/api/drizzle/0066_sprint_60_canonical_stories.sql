CREATE TABLE `canonical_external_stories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`first_observed_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`current_enrichment_version` integer DEFAULT 0 NOT NULL,
	`merged_into_story_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canonical_stories_workspace_status` ON `canonical_external_stories` (`workspace_id`,`status`,`last_observed_at`);--> statement-breakpoint
CREATE TABLE `canonical_story_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`story_id` text NOT NULL,
	`key_kind` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_story_keys_identity` ON `canonical_story_keys` (`workspace_id`,`key_kind`,`key_hash`);--> statement-breakpoint
CREATE INDEX `canonical_story_keys_story` ON `canonical_story_keys` (`story_id`);--> statement-breakpoint
CREATE TABLE `discovery_source_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_name` text NOT NULL,
	`fetch_run_id` text,
	`provider_external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`author` text,
	`provider_published_at` integer,
	`observed_at` integer NOT NULL,
	`normalized_url_key` text,
	`content_fingerprint` text NOT NULL,
	`raw_metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discovery_source_occurrences_source_external` ON `discovery_source_occurrences` (`source_id`,`provider_external_id`);--> statement-breakpoint
CREATE INDEX `discovery_source_occurrences_workspace_observed` ON `discovery_source_occurrences` (`workspace_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `story_enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`story_id` text NOT NULL,
	`story_fingerprint` text NOT NULL,
	`enricher_version` integer NOT NULL,
	`corroboration_count` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_enrichments_identity` ON `story_enrichments` (`story_id`,`story_fingerprint`,`enricher_version`);--> statement-breakpoint
CREATE TABLE `story_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`story_id` text NOT NULL,
	`occurrence_id` text NOT NULL,
	`relationship_kind` text NOT NULL,
	`confidence` integer NOT NULL,
	`matcher_version` integer DEFAULT 1 NOT NULL,
	`attached_at` integer NOT NULL,
	`attached_by_user_id` text,
	`attach_reason` text,
	`detached_at` integer,
	`detached_by_user_id` text,
	`detach_reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `canonical_external_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`occurrence_id`) REFERENCES `discovery_source_occurrences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_occurrences_one_active` ON `story_occurrences` (`occurrence_id`) WHERE "story_occurrences"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX `story_occurrences_story` ON `story_occurrences` (`story_id`,`detached_at`);