CREATE TABLE `email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`external_action_id` text NOT NULL,
	`origin` text NOT NULL,
	`origin_id` text NOT NULL,
	`normalized_recipient` text NOT NULL,
	`sender_address` text NOT NULL,
	`reply_to` text,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`idempotency_key` text NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`provider_message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`accepted_at` integer,
	`completed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_action_id`) REFERENCES `external_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_deliveries_workspace_idempotency` ON `email_deliveries` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_deliveries_provider_message` ON `email_deliveries` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `email_deliveries_workspace_status_accepted` ON `email_deliveries` (`workspace_id`,`status`,`accepted_at`);--> statement-breakpoint
CREATE INDEX `email_deliveries_workspace_origin` ON `email_deliveries` (`workspace_id`,`origin`,`origin_id`);--> statement-breakpoint
CREATE TABLE `email_delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`provider_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivery_id`) REFERENCES `email_deliveries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_delivery_events_payload_bounded" CHECK(length("email_delivery_events"."payload_json") <= 1000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_delivery_events_provider_event` ON `email_delivery_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `email_delivery_events_delivery_created` ON `email_delivery_events` (`delivery_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_recipient_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`normalized_email` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_recipient_permissions_workspace_email` ON `email_recipient_permissions` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE INDEX `email_recipient_permissions_workspace_status` ON `email_recipient_permissions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`normalized_email` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_suppressions_workspace_email` ON `email_suppressions` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE INDEX `email_suppressions_workspace_created` ON `email_suppressions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_email_senders` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`from_local_part` text NOT NULL,
	`from_name` text NOT NULL,
	`from_address` text NOT NULL,
	`reply_to` text,
	`status` text DEFAULT 'not_configured' NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`provider_domain_id` text,
	`dns_records_json` text DEFAULT '[]' NOT NULL,
	`kill_switch` integer DEFAULT true NOT NULL,
	`daily_cap` integer DEFAULT 100 NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
