-- Drop the FK constraint on todo.session_id so todos can be created
-- independently of session rows (required for tests and compaction use-cases).
-- SQLite does not support DROP CONSTRAINT, so we recreate the table.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todo` (
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`)
);
--> statement-breakpoint
INSERT INTO `__new_todo`(`session_id`, `content`, `status`, `priority`, `position`, `time_created`, `time_updated`) SELECT `session_id`, `content`, `status`, `priority`, `position`, `time_created`, `time_updated` FROM `todo`;
--> statement-breakpoint
DROP TABLE `todo`;
--> statement-breakpoint
ALTER TABLE `__new_todo` RENAME TO `todo`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
