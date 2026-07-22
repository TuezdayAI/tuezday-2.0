ALTER TABLE `campaign_lane_revisions` ADD `key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_lane_revisions` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `campaign_lane_revisions`
SET
	`key` = (SELECT `campaign_lanes`.`key` FROM `campaign_lanes` WHERE `campaign_lanes`.`id` = `campaign_lane_revisions`.`lane_id`),
	`name` = (SELECT `campaign_lanes`.`name` FROM `campaign_lanes` WHERE `campaign_lanes`.`id` = `campaign_lane_revisions`.`lane_id`);
