CREATE TABLE `ad_launch_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`launch_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`action` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`launch_id`) REFERENCES `ad_launches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ad_launches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ad_account_id` text NOT NULL,
	`campaign_id` text,
	`creative_draft_id` text NOT NULL,
	`name` text NOT NULL,
	`objective` text NOT NULL,
	`page_id` text NOT NULL,
	`link_url` text NOT NULL,
	`daily_budget_cents` integer NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`countries_json` text NOT NULL,
	`age_min` integer NOT NULL,
	`age_max` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`external_campaign_id` text,
	`external_ad_set_id` text,
	`external_creative_id` text,
	`external_ad_id` text,
	`ad_campaign_id` text,
	`platform_status` text,
	`launched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ad_account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`creative_draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ad_campaign_id`) REFERENCES `ad_campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ad_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`daily_cap_cents` integer DEFAULT 5000 NOT NULL,
	`kill_switch` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
