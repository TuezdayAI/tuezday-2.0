CREATE TABLE `background_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`active_key` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`available_at` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`lease_owner` text,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`last_error` text,
	`result_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_jobs_active_key_unique` ON `background_jobs` (`active_key`);--> statement-breakpoint
CREATE INDEX `background_jobs_status_available` ON `background_jobs` (`status`,`available_at`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `background_jobs_workspace_status` ON `background_jobs` (`workspace_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `background_jobs_lease_expiry` ON `background_jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `background_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_enqueued_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_schedules_workspace_kind_unique` ON `background_schedules` (`workspace_id`,`kind`);--> statement-breakpoint
CREATE INDEX `background_schedules_due` ON `background_schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `background_workspace_dispatch` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`last_dispatched_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
