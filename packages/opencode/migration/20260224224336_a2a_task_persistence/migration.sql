CREATE TABLE `a2a_task` (
	`id` text PRIMARY KEY,
	`context_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`state` text NOT NULL,
	`message` text,
	`artifacts` text,
	`history` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `a2a_task_agent_idx` ON `a2a_task` (`agent_id`);--> statement-breakpoint
CREATE INDEX `a2a_task_context_idx` ON `a2a_task` (`context_id`);--> statement-breakpoint
CREATE INDEX `a2a_task_state_idx` ON `a2a_task` (`state`);