CREATE TABLE `session_cron` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `interval_ms` integer NOT NULL,
  `prompt` text NOT NULL,
  `next_run_at` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `session_cron_session_idx` ON `session_cron` (`session_id`);
CREATE INDEX `session_cron_next_run_idx` ON `session_cron` (`next_run_at`);
