ALTER TABLE `discovered_items` ADD `matching_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_input_fingerprint` text;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_lease_owner` text;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `discovered_items` ADD `matching_error` text;--> statement-breakpoint
CREATE INDEX `discovered_items_matching_queue` ON `discovered_items` (`matching_state`,`matching_lease_expires_at`,`created_at`);