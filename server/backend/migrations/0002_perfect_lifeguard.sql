ALTER TABLE "auth_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "auth_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "privy_user_id" TO "workos_user_id";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_privy_user_id_unique";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workos_user_id_unique" UNIQUE("workos_user_id");