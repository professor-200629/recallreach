CREATE TABLE `case_memory` (
	`case_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`engine` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`integration` text NOT NULL,
	`mode` text NOT NULL,
	`operation` text NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`detail` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_checks_owner_at` ON `integration_checks` (`owner_id`,`at`);