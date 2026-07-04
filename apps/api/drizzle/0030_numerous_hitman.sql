CREATE TABLE `context_matrix_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_type` text NOT NULL,
	`doc_type` text NOT NULL,
	`mode` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_matrix_overrides_workspace_task_doc` ON `context_matrix_overrides` (`workspace_id`,`task_type`,`doc_type`);--> statement-breakpoint
ALTER TABLE `brain_documents` ADD `outline_json` text;