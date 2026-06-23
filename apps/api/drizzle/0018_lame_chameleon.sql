CREATE TABLE `evidence_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source_created_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`evidence_document_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_candidates_source` ON `evidence_candidates` (`workspace_id`,`kind`,`source_ref`);--> statement-breakpoint
CREATE TABLE `evidence_collections` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`r2r_collection_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `evidence_documents` ADD `kind` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence_documents` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `evidence_documents` ADD `source_created_at` integer;