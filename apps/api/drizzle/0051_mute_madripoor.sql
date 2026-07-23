CREATE TABLE `evidence_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`document_id` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` blob,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_chunks_collection` ON `evidence_chunks` (`collection_id`);--> statement-breakpoint
CREATE INDEX `evidence_chunks_document` ON `evidence_chunks` (`document_id`);