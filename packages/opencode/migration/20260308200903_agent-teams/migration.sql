CREATE TABLE `team_message` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`from_session_id` text NOT NULL,
	`to_session_id` text,
	`content` text NOT NULL,
	`read_by` text DEFAULT '[]',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_team_message_team_id_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_team_message_from_session_id_session_id_fk` FOREIGN KEY (`from_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_team_message_to_session_id_session_id_fk` FOREIGN KEY (`to_session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `team` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`lead_session_id` text,
	`delegate` integer DEFAULT false,
	`status` text DEFAULT 'active' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_team_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_team_lead_session_id_session_id_fk` FOREIGN KEY (`lead_session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `team_name_project_idx` UNIQUE(`name`,`project_id`)
);
--> statement-breakpoint
CREATE TABLE `team_task` (
	`id` text NOT NULL,
	`team_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`assigned_to` text,
	`depends_on` text DEFAULT '[]',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `team_task_pk` PRIMARY KEY(`team_id`, `id`),
	CONSTRAINT `fk_team_task_team_id_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_team_task_assigned_to_session_id_fk` FOREIGN KEY (`assigned_to`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `session` ADD `team_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `team_role` text;--> statement-breakpoint
ALTER TABLE `session` ADD `plan_approval` text;--> statement-breakpoint
ALTER TABLE `session` ADD `team_meta` text;--> statement-breakpoint
CREATE INDEX `session_team_idx` ON `session` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_message_team_idx` ON `team_message` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_message_from_idx` ON `team_message` (`from_session_id`);--> statement-breakpoint
CREATE INDEX `team_message_to_idx` ON `team_message` (`to_session_id`);--> statement-breakpoint
CREATE INDEX `team_project_idx` ON `team` (`project_id`);--> statement-breakpoint
CREATE INDEX `team_lead_session_idx` ON `team` (`lead_session_id`);--> statement-breakpoint
CREATE INDEX `team_task_team_idx` ON `team_task` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_task_assigned_idx` ON `team_task` (`assigned_to`);--> statement-breakpoint
CREATE INDEX `team_task_status_idx` ON `team_task` (`status`);