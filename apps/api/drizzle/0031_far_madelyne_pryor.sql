DROP INDEX `guidance_overrides_workspace_channel`;--> statement-breakpoint
ALTER TABLE `guidance_overrides` ADD `persona_id` text REFERENCES personas(id);--> statement-breakpoint
ALTER TABLE `guidance_overrides` ADD `campaign_id` text REFERENCES campaigns(id);--> statement-breakpoint
CREATE UNIQUE INDEX `guidance_overrides_workspace_channel_scope` ON `guidance_overrides` (`workspace_id`,`channel`,`persona_id`,`campaign_id`);--> statement-breakpoint
ALTER TABLE `connections` ADD `content_profile_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `topics_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `tone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `style_rules` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `avoid` text DEFAULT '' NOT NULL;