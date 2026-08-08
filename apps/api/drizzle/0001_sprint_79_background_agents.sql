CREATE TABLE "agent_task_messages" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text DEFAULT 'steer' NOT NULL,
	"content" text NOT NULL,
	"consumed_at" bigint,
	"consumed_at_step" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"created_by" text NOT NULL,
	"request" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"agent_run_id" text,
	"job_id" text,
	"transcript_json" text,
	"output_text" text,
	"stop_reason" text,
	"error" text,
	"step_count" bigint DEFAULT 0 NOT NULL,
	"subagent_count" bigint DEFAULT 0 NOT NULL,
	"steer_count" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"cancel_requested_at" bigint,
	"acknowledged_at" bigint,
	"created_at" bigint NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_proposals" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "agent_task_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "agent_task_id" text;--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD COLUMN "agent_task_id" text;--> statement-breakpoint
ALTER TABLE "agent_task_messages" ADD CONSTRAINT "agent_task_messages_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_messages" ADD CONSTRAINT "agent_task_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_task_messages_task_created" ON "agent_task_messages" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_workspace_created" ON "agent_tasks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_workspace_status" ON "agent_tasks" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_session_created" ON "agent_tasks" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_questions_task" ON "agent_questions" USING btree ("agent_task_id");--> statement-breakpoint
CREATE INDEX "agent_runs_parent" ON "agent_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "chat_proposals_task_created" ON "chat_proposals" USING btree ("agent_task_id","created_at");