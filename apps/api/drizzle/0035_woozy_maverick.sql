ALTER TABLE `workspaces` ADD `website_url` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `onboarding_step` text;--> statement-breakpoint
ALTER TABLE `workspace_members` DROP COLUMN `onboarding_dismissed_at`;