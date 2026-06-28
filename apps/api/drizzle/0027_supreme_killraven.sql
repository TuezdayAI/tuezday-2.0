ALTER TABLE `connections` ADD `display_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_account_id` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_account_name` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_account_handle` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_account_url` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `connections` SET `updated_at` = `created_at` WHERE `updated_at` = 0;--> statement-breakpoint
CREATE TABLE `persona_social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`channel` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`default_target` text DEFAULT 'feed' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persona_social_accounts_unique` ON `persona_social_accounts` (`persona_id`,`connection_id`,`channel`);
