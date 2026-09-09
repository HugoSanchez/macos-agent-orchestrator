CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"event_type" text NOT NULL,
	"session_id" text,
	"tool_call_count" integer,
	"occurred_at" timestamp with time zone NOT NULL
);
