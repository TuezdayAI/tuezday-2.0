ALTER TABLE `drafts` ADD `automation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_automation_key` ON `drafts` (`automation_key`) WHERE "drafts"."automation_key" IS NOT NULL;