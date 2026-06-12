CREATE TABLE `ad_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_accounts_workspace_external` ON `ad_accounts` (`workspace_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `ad_campaign_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ad_campaign_id` text NOT NULL,
	`date` text NOT NULL,
	`spend_cents` integer DEFAULT 0 NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`conversions` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ad_campaign_id`) REFERENCES `ad_campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_campaign_metrics_campaign_date` ON `ad_campaign_metrics` (`ad_campaign_id`,`date`);--> statement-breakpoint
CREATE TABLE `ad_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ad_account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`campaign_id` text,
	`last_synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ad_account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_campaigns_account_external` ON `ad_campaigns` (`ad_account_id`,`external_id`);