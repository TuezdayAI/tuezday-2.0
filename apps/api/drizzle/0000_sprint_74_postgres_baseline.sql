CREATE TABLE "ad_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"last_synced_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaign_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"ad_campaign_id" text NOT NULL,
	"date" text NOT NULL,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"conversions" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"ad_account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"campaign_id" text,
	"last_synced_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_launch_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"action" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"actor_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_launches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"ad_account_id" text NOT NULL,
	"campaign_id" text,
	"creative_draft_id" text NOT NULL,
	"external_action_id" text,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"page_id" text NOT NULL,
	"link_url" text NOT NULL,
	"daily_budget_cents" bigint NOT NULL,
	"start_at" bigint,
	"end_at" bigint,
	"countries_json" text NOT NULL,
	"age_min" bigint NOT NULL,
	"age_max" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"external_campaign_id" text,
	"external_ad_set_id" text,
	"external_creative_id" text,
	"external_ad_id" text,
	"meta_image_hash" text,
	"ad_campaign_id" text,
	"platform_status" text,
	"launched_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"daily_cap_cents" bigint DEFAULT 5000 NOT NULL,
	"kill_switch" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"tool" text NOT NULL,
	"target_kind" text NOT NULL,
	"draft_id" text,
	"external_action_id" text,
	"campaign_id" text,
	"summary" text NOT NULL,
	"rationale" text NOT NULL,
	"chat_session_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"pipeline_run_id" text,
	"step_key" text,
	"type" text NOT NULL,
	"question" text NOT NULL,
	"why" text NOT NULL,
	"options_json" text,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_by_user_id" text,
	"answered_by_label" text,
	"answered_at" bigint,
	"rule_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_index" bigint NOT NULL,
	"kind" text NOT NULL,
	"message_json" text,
	"tool_name" text,
	"tool_call_id" text,
	"tool_args_json" text,
	"tool_result_json" text,
	"tool_error" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task" text NOT NULL,
	"created_by" text NOT NULL,
	"status" text NOT NULL,
	"stop_reason" text,
	"error" text,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"system" text NOT NULL,
	"input_messages_json" text NOT NULL,
	"output_json" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"step_count" bigint DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes_json" text NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_action_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"action" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"action" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"content_snapshot" text,
	"content_fingerprint" text,
	"actor" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"member_type" text NOT NULL,
	"member_id" text NOT NULL,
	"added_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"rules_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"active_key" text,
	"priority" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"available_at" bigint NOT NULL,
	"attempt" bigint DEFAULT 0 NOT NULL,
	"max_attempts" bigint DEFAULT 5 NOT NULL,
	"lease_owner" text,
	"lease_version" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" bigint,
	"heartbeat_at" bigint,
	"started_at" bigint,
	"finished_at" bigint,
	"last_error" text,
	"result_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"interval_ms" bigint NOT NULL,
	"next_run_at" bigint NOT NULL,
	"last_enqueued_at" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_workspace_dispatch" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"last_dispatched_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" bigint NOT NULL,
	"content" text NOT NULL,
	"actor" text,
	"actor_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"outline_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_url" text NOT NULL,
	"status" text DEFAULT 'scraping' NOT NULL,
	"profile_json" text,
	"error" text,
	"corpus_chars" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_lane_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lane_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"persona_id" text NOT NULL,
	"audience_id" text,
	"channel" text NOT NULL,
	"format" text NOT NULL,
	"publishing_connection_id" text,
	"provider_target" text DEFAULT '' NOT NULL,
	"delivery_mode" text NOT NULL,
	"planned_quantity" bigint DEFAULT 0 NOT NULL,
	"schedule_json" text,
	"reactive_period" text,
	"reactive_cap" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_lanes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"canonical_story_id" text,
	"manual_signal_id" text,
	"campaign_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"routing_profile_id" text NOT NULL,
	"status" text NOT NULL,
	"angle" text NOT NULL,
	"angle_hash" text NOT NULL,
	"workspace_relevance" bigint NOT NULL,
	"campaign_fit" bigint NOT NULL,
	"confidence" bigint NOT NULL,
	"actionability" bigint NOT NULL,
	"source_trust" bigint NOT NULL,
	"suggested_persona_id" text,
	"supported_claims_json" text DEFAULT '[]' NOT NULL,
	"reason" text NOT NULL,
	"matcher_version" bigint NOT NULL,
	"policy_json" text NOT NULL,
	"expires_at" bigint,
	"decided_by_user_id" text,
	"decided_at" bigint,
	"decision_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "campaign_opportunities_trigger_xor" CHECK (("campaign_opportunities"."canonical_story_id" IS NULL) <> ("campaign_opportunities"."manual_signal_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "campaign_opportunity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_plan_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"kpi" text DEFAULT '' NOT NULL,
	"timeframe" text DEFAULT '' NOT NULL,
	"start_at" bigint,
	"end_at" bigint,
	"audience_ids_json" text DEFAULT '[]' NOT NULL,
	"pillars_json" text DEFAULT '[]' NOT NULL,
	"offers_json" text DEFAULT '[]' NOT NULL,
	"ctas_json" text DEFAULT '[]' NOT NULL,
	"guidance" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"activated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "campaign_routing_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"profile_version" bigint NOT NULL,
	"profile_fingerprint" text NOT NULL,
	"routing_band" text NOT NULL,
	"min_fit" bigint NOT NULL,
	"min_confidence" bigint NOT NULL,
	"min_trust" bigint NOT NULL,
	"compiler_version" bigint NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"kpi" text DEFAULT '' NOT NULL,
	"timeframe" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"pillars_json" text DEFAULT '[]' NOT NULL,
	"channels_json" text DEFAULT '[]' NOT NULL,
	"persona_ids_json" text DEFAULT '[]' NOT NULL,
	"overlay" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"purpose" text DEFAULT 'initiative' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"automation_mode" text DEFAULT 'manual' NOT NULL,
	"auto_daily_cap" bigint,
	"routing_band" text DEFAULT 'review' NOT NULL,
	"routing_min_fit" bigint DEFAULT 70 NOT NULL,
	"routing_min_confidence" bigint DEFAULT 60 NOT NULL,
	"routing_min_trust" bigint DEFAULT 0 NOT NULL,
	"routing_exclusions_json" text DEFAULT '[]' NOT NULL,
	"current_plan_revision_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_external_stories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"first_observed_at" bigint NOT NULL,
	"last_observed_at" bigint NOT NULL,
	"current_enrichment_version" bigint DEFAULT 0 NOT NULL,
	"merged_into_story_id" text,
	"archived_at" bigint,
	"routing_state" text DEFAULT 'pending' NOT NULL,
	"routing_fingerprint" text,
	"routing_lease_expires_at" bigint,
	"routing_attempts" bigint DEFAULT 0 NOT NULL,
	"routed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_story_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"story_id" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_name" text,
	"citations_json" text DEFAULT '[]' NOT NULL,
	"cards_json" text DEFAULT '[]' NOT NULL,
	"proposal_json" text,
	"produced_ref" text,
	"agent_run_id" text,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"agent_run_id" text,
	"tool" text NOT NULL,
	"args_json" text NOT NULL,
	"intent_json" text NOT NULL,
	"status" text NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"quarantine_reason" text,
	"produced_ref" text,
	"produced_status" text,
	"error" text,
	"error_message" text,
	"confirmed_by_user_id" text,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"title" text DEFAULT '' NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"campaign_id" text,
	"persona_id" text,
	"channel" text,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" double precision DEFAULT 0 NOT NULL,
	"compacted_through_message_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"nango_connection_id" text NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"external_account_id" text,
	"external_account_name" text,
	"external_account_handle" text,
	"external_account_url" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_checked_at" bigint,
	"last_error" text,
	"content_profile_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_package_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"package_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"opportunity_id" text,
	"canonical_story_id" text,
	"angle" text NOT NULL,
	"angle_hash" text NOT NULL,
	"novelty" bigint NOT NULL,
	"status" text DEFAULT 'assessing' NOT NULL,
	"assessment_state" text DEFAULT 'pending' NOT NULL,
	"assessment_attempts" bigint DEFAULT 0 NOT NULL,
	"assessment_lease_expires_at" bigint,
	"assessed_at" bigint,
	"fanned_out_at" bigint,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_matrix_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task_type" text NOT NULL,
	"doc_type" text NOT NULL,
	"mode" text NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deliverable_id" text NOT NULL,
	"package_id" text,
	"resolved_context_json" text NOT NULL,
	"inputs_json" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"lead_id" text,
	"discarded_at" bigint,
	"last_synced_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sync_settings" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"filter_json" text DEFAULT '{}' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverable_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deliverable_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"lane_id" text NOT NULL,
	"lane_revision_id" text NOT NULL,
	"kind" text NOT NULL,
	"original_scheduled_for" bigint,
	"package_id" text,
	"angle" text DEFAULT '' NOT NULL,
	"angle_hash" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"generation_state" text DEFAULT 'pending' NOT NULL,
	"generation_attempts" bigint DEFAULT 0 NOT NULL,
	"generation_lease_expires_at" bigint,
	"generated_at" bigint,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_overlays" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"channel" text NOT NULL,
	"persona_id" text,
	"campaign_id" text,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"is_default" bigint DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"design_system_fingerprint" text NOT NULL,
	"slide_shape" text NOT NULL,
	"html" text NOT NULL,
	"css" text NOT NULL,
	"placeholders_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_item_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"persona_id" text,
	"campaign_id" text,
	"score" bigint NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"published_at" bigint,
	"score" bigint,
	"suggested_persona_id" text,
	"suggested_campaign_id" text,
	"score_reason" text,
	"status" text DEFAULT 'new' NOT NULL,
	"signal_id" text,
	"scored_at" bigint,
	"matching_state" text DEFAULT 'pending' NOT NULL,
	"matching_version" bigint DEFAULT 0 NOT NULL,
	"matching_input_fingerprint" text,
	"matching_lease_owner" text,
	"matching_lease_expires_at" bigint,
	"matching_heartbeat_at" bigint,
	"matching_error" text,
	"url_hash" text,
	"content_hash" text DEFAULT '' NOT NULL,
	"duplicate_of_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text NOT NULL,
	"attempt" bigint DEFAULT 0 NOT NULL,
	"locked_at" bigint,
	"source_execution_version" bigint DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_version" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" bigint,
	"heartbeat_at" bigint,
	"started_at" bigint,
	"finished_at" bigint,
	"fetched_count" bigint DEFAULT 0 NOT NULL,
	"new_count" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_source_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_name" text NOT NULL,
	"fetch_run_id" text,
	"provider_external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"author" text,
	"provider_published_at" bigint,
	"observed_at" bigint NOT NULL,
	"normalized_url_key" text,
	"content_fingerprint" text NOT NULL,
	"raw_metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config_json" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"last_fetched_at" bigint,
	"connection_id" text,
	"cursor_json" text DEFAULT '{}' NOT NULL,
	"backoff_until" bigint,
	"last_attempted_at" bigint,
	"execution_version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_revision_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"actor_id" text,
	"instruction" text NOT NULL,
	"source_content" text NOT NULL,
	"result_content" text,
	"sections_json" text DEFAULT '[]' NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"model" text,
	"provider" text,
	"duration_ms" bigint,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_generation_id" text,
	"source_signal_id" text,
	"campaign_id" text,
	"lead_id" text,
	"media_contact_id" text,
	"task_type" text NOT NULL,
	"channel" text NOT NULL,
	"persona_id" text,
	"original_content" text NOT NULL,
	"content" text NOT NULL,
	"state" text NOT NULL,
	"automation_key" text,
	"review_json" text,
	"media_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"external_action_id" text NOT NULL,
	"origin" text NOT NULL,
	"origin_id" text NOT NULL,
	"normalized_recipient" text NOT NULL,
	"sender_address" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text,
	"idempotency_key" text NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"mailbox_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"accepted_at" bigint,
	"completed_at" bigint,
	"last_error" text,
	"opened_at" bigint,
	"open_count" bigint DEFAULT 0 NOT NULL,
	"first_click_at" bigint,
	"click_count" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "email_delivery_events_payload_bounded" CHECK (length("email_delivery_events"."payload_json") <= 1000000)
);
--> statement-breakpoint
CREATE TABLE "email_recipient_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"draft_id" text,
	"channel" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"impressions" bigint,
	"engagements" bigint,
	"clicks" bigint,
	"notes" text DEFAULT '' NOT NULL,
	"recorded_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_case_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"pipeline_run_id" text,
	"produced_content" text,
	"checks_json" text DEFAULT '[]' NOT NULL,
	"judge_json" text,
	"verdict" text,
	"edit_distance_to_final" double precision,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"signal_id" text,
	"signal_content" text NOT NULL,
	"signal_source" text NOT NULL,
	"channel" text NOT NULL,
	"campaign_id" text,
	"persona_id" text,
	"source_draft_id" text,
	"generated_content" text NOT NULL,
	"final_content" text NOT NULL,
	"outcome" text NOT NULL,
	"rejection_reason" text,
	"decided_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"definition_id" text,
	"definition_version" bigint,
	"status" text DEFAULT 'running' NOT NULL,
	"judge_enabled" boolean DEFAULT false NOT NULL,
	"metrics_json" text NOT NULL,
	"baseline_label" text,
	"failure_reason" text,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"task_key" text NOT NULL,
	"channel" text NOT NULL,
	"cta_expectation" text DEFAULT 'any' NOT NULL,
	"case_count" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_created_at" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_document_id" text,
	"created_at" bigint NOT NULL,
	"decided_at" bigint
);
--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"document_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(768),
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_collections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"r2r_collection_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"r2r_document_id" text,
	"title" text NOT NULL,
	"chars" bigint NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text,
	"kind" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"source_created_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_action_batch_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"action_id" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"status" text NOT NULL,
	"submission_json" text,
	"error" text,
	"processed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "external_action_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"request_id" text NOT NULL,
	"selection_json" text NOT NULL,
	"status" text NOT NULL,
	"continuation_count" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_label" text NOT NULL,
	"created_at" bigint NOT NULL,
	"confirmed_at" bigint,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "external_action_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"action_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"actor_label" text NOT NULL,
	"actor_human" boolean DEFAULT true NOT NULL,
	"subject_fingerprint" text NOT NULL,
	"policy_snapshot_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_action_policy_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"rule" text NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"draft_id" text,
	"campaign_id" text,
	"persona_id" text,
	"connection_id" text,
	"lane_revision_id" text,
	"payload_json" text NOT NULL,
	"subject_snapshot_json" text NOT NULL,
	"requested_for" bigint,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"policy_snapshot_json" text NOT NULL,
	"blocker_code" text,
	"blocker_detail" text,
	"blocker_retryable" boolean,
	"supersedes_action_id" text,
	"superseded_by_action_id" text,
	"execution_kind" text,
	"execution_id" text,
	"execution_receipt_json" text,
	"proposed_by_user_id" text,
	"proposed_by_label" text NOT NULL,
	"origin" text DEFAULT 'human' NOT NULL,
	"origin_run_id" text,
	"origin_surface" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"authorized_at" bigint,
	"dispatched_at" bigint,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "generation_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"review_enabled" bigint DEFAULT 1 NOT NULL,
	"angle_enabled" bigint DEFAULT 0 NOT NULL,
	"angle_count" bigint DEFAULT 3 NOT NULL,
	"flag_threshold" bigint DEFAULT 70 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task_type" text NOT NULL,
	"channel" text NOT NULL,
	"persona_id" text,
	"campaign_id" text,
	"lead_id" text,
	"media_contact_id" text,
	"prompt" text NOT NULL,
	"sections_json" text NOT NULL,
	"output" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"duration_ms" bigint NOT NULL,
	"rating" text,
	"rated_at" bigint,
	"review_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidance_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text NOT NULL,
	"persona_id" text,
	"campaign_id" text,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"publication_id" text,
	"launch_message_id" text,
	"author_handle" text DEFAULT '' NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'unread' NOT NULL,
	"reply_draft_id" text,
	"external_action_id" text,
	"posted_reply_external_id" text,
	"posted_reply_url" text,
	"email_delivery_id" text,
	"reply_label" text,
	"reply_labeled_at" bigint,
	"external_created_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_eligibility_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"package_id" text NOT NULL,
	"assessment_id" text NOT NULL,
	"lane_id" text NOT NULL,
	"lane_revision_id" text NOT NULL,
	"eligible" boolean NOT NULL,
	"checks_json" text NOT NULL,
	"evaluator_version" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"launch_id" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_type" text,
	"recipient_id" text,
	"recipient_name" text DEFAULT '' NOT NULL,
	"recipient_email" text DEFAULT '' NOT NULL,
	"recipient_handle" text,
	"draft_id" text,
	"external_action_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"external_id" text,
	"external_url" text,
	"publication_id" text,
	"sent_at" bigint,
	"last_error" text,
	"step_number" bigint DEFAULT 1 NOT NULL,
	"sequence_recipient_id" text,
	"connection_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"audience_id" text,
	"campaign_id" text,
	"persona_id" text,
	"channels_json" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"automation_mode" text DEFAULT 'manual' NOT NULL,
	"stop_on_reply" bigint DEFAULT 1 NOT NULL,
	"x_connection_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"x_handle" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"pipeline" text NOT NULL,
	"campaign_id" text,
	"agent_run_id" text,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"address" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"reply_to" text,
	"signature" text DEFAULT '' NOT NULL,
	"daily_cap" bigint DEFAULT 50 NOT NULL,
	"sending_window_json" text DEFAULT '{}' NOT NULL,
	"default_persona_id" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_polled_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"type" text DEFAULT 'journalist' NOT NULL,
	"outlet" text DEFAULT '' NOT NULL,
	"beat" text DEFAULT '' NOT NULL,
	"coverage_notes" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"metric_key" text NOT NULL,
	"value" bigint NOT NULL,
	"window" text NOT NULL,
	"period_start" bigint NOT NULL,
	"source" text NOT NULL,
	"captured_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"target" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "now_syntheses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"proposal" text NOT NULL,
	"rationale" text NOT NULL,
	"based_on_json" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" bigint NOT NULL,
	"decided_at" bigint
);
--> statement-breakpoint
CREATE TABLE "outreach_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_email" text DEFAULT '' NOT NULL,
	"mailbox_id" text,
	"last_thread_id" text,
	"current_step" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_due_at" bigint,
	"last_sent_at" bigint,
	"stopped_reason" text,
	"last_reply_handled_at" bigint,
	"outcome" text DEFAULT 'none' NOT NULL,
	"enrolled_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"enrollment_id" text NOT NULL,
	"step_number" bigint NOT NULL,
	"draft_id" text,
	"external_action_id" text,
	"provider_thread_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_sequence_mailboxes" (
	"sequence_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	CONSTRAINT "outreach_sequence_mailboxes_sequence_id_mailbox_id_pk" PRIMARY KEY("sequence_id","mailbox_id")
);
--> statement-breakpoint
CREATE TABLE "outreach_sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"step_number" bigint NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"delay_hours" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"persona_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"automation_mode" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"daily_enrollment_cap" bigint DEFAULT 50 NOT NULL,
	"stop_on_reply" bigint DEFAULT 1 NOT NULL,
	"track_opens" bigint DEFAULT 0 NOT NULL,
	"track_clicks" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_tracking_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email_delivery_id" text,
	"type" text NOT NULL,
	"target_url" text,
	"occurred_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"package_id" text NOT NULL,
	"role" text NOT NULL,
	"canonical_story_id" text,
	"occurrence_id" text,
	"signal_id" text,
	"title" text DEFAULT '' NOT NULL,
	"url" text,
	"excerpt" text DEFAULT '' NOT NULL,
	"snapshot_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"channel" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"default_target" text DEFAULT 'feed' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"overlay" text DEFAULT '' NOT NULL,
	"topics_json" text DEFAULT '[]' NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"style_rules" text DEFAULT '' NOT NULL,
	"avoid" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_definition_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"version" bigint NOT NULL,
	"spec_json" text NOT NULL,
	"actor_label" text NOT NULL,
	"actor_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"campaign_id" text,
	"lane_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" bigint DEFAULT 1 NOT NULL,
	"spec_json" text NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_rollout_decisions" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task_key" text NOT NULL,
	"decision" text NOT NULL,
	"rationale" text NOT NULL,
	"metrics_json" text NOT NULL,
	"decided_by_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_run_steps" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"iteration" bigint DEFAULT 1 NOT NULL,
	"attempt" bigint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agent_run_id" text,
	"output_json" text,
	"passes" bigint DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"stop_reason" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"definition_version" bigint NOT NULL,
	"task_key" text NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"dry_run_batch_id" text,
	"signal_id" text,
	"campaign_id" text,
	"lane_id" text,
	"persona_id" text,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"paused_at_step_key" text,
	"escalation_reason" text,
	"failure_reason" text,
	"checklist_json" text DEFAULT '[]' NOT NULL,
	"result_json" text,
	"generation_id" text,
	"draft_id" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_shadow_pairs" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"pair_key" text NOT NULL,
	"signal_id" text,
	"campaign_id" text,
	"channel" text NOT NULL,
	"draft_id" text,
	"run_id" text NOT NULL,
	"verdict" text,
	"verdict_notes" text DEFAULT '' NOT NULL,
	"verdict_by_user_id" text,
	"verdict_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_cadences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"campaign_id" text,
	"persona_id" text,
	"channel" text NOT NULL,
	"connection_id" text NOT NULL,
	"target" text NOT NULL,
	"days_of_week_json" text NOT NULL,
	"time_of_day" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"draft_id" text,
	"task_type" text NOT NULL,
	"channel" text NOT NULL,
	"before_content" text NOT NULL,
	"after_content" text NOT NULL,
	"instruction" text,
	"edit_distance" double precision DEFAULT 0 NOT NULL,
	"digested_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_rule_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"edit_id" text NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"rule" text NOT NULL,
	"polarity" text NOT NULL,
	"scope_task_type" text,
	"scope_channel" text,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"confidence" bigint DEFAULT 0 NOT NULL,
	"observation_count" bigint DEFAULT 0 NOT NULL,
	"applied_count" bigint DEFAULT 0 NOT NULL,
	"last_observed_at" bigint,
	"last_applied_at" bigint,
	"promoted_at" bigint,
	"retired_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"window" text NOT NULL,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"impressions" bigint,
	"clicks" bigint,
	"captured_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"external_action_id" text,
	"connection_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"target" text NOT NULL,
	"title" text NOT NULL,
	"media_json" text,
	"cadence_id" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"published_at" bigint,
	"external_id" text,
	"external_url" text,
	"last_error" text,
	"provider_operation_id" text,
	"next_attempt_at" bigint,
	"processing_started_at" bigint,
	"processing_attempts" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"launch_id" text NOT NULL,
	"channel" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_name" text DEFAULT '' NOT NULL,
	"recipient_email" text DEFAULT '' NOT NULL,
	"recipient_handle" text,
	"current_step" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_due_at" bigint,
	"last_sent_at" bigint,
	"stopped_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"launch_id" text NOT NULL,
	"channel" text NOT NULL,
	"step_number" bigint NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"delay_hours" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"persona_id" text,
	"campaign_id" text,
	"score" bigint NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"suggested_persona_id" text,
	"suggested_campaign_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_automation_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"kill_switch" bigint DEFAULT 0 NOT NULL,
	"per_connection_daily_cap" bigint DEFAULT 10 NOT NULL,
	"per_connection_reply_daily_cap" bigint DEFAULT 10 NOT NULL,
	"per_campaign_daily_cap" bigint DEFAULT 5 NOT NULL,
	"auto_reply_enabled" bigint DEFAULT 0 NOT NULL,
	"match_threshold" bigint DEFAULT 50 NOT NULL,
	"generation_path" text DEFAULT 'legacy' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_enrichments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"story_id" text NOT NULL,
	"story_fingerprint" text NOT NULL,
	"enricher_version" bigint NOT NULL,
	"corroboration_count" bigint NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"story_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"relationship_kind" text NOT NULL,
	"confidence" bigint NOT NULL,
	"matcher_version" bigint DEFAULT 1 NOT NULL,
	"attached_at" bigint NOT NULL,
	"attached_by_user_id" text,
	"attach_reason" text,
	"detached_at" bigint,
	"detached_by_user_id" text,
	"detach_reason" text
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sufficiency_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"package_id" text NOT NULL,
	"assessment_version" bigint NOT NULL,
	"verdict" text NOT NULL,
	"confidence" bigint NOT NULL,
	"supported_claims_json" text DEFAULT '[]' NOT NULL,
	"missing_facts_json" text DEFAULT '[]' NOT NULL,
	"missing_media_json" text DEFAULT '[]' NOT NULL,
	"eligible_formats_json" text DEFAULT '[]' NOT NULL,
	"ineligible_formats_json" text DEFAULT '[]' NOT NULL,
	"research_actions_json" text DEFAULT '[]' NOT NULL,
	"assessor_version" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"expires_at" bigint NOT NULL,
	"heartbeat_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"external_id" text,
	"url" text,
	"notes" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_resolved_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"google_sub" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deliverable_id" text NOT NULL,
	"variant_version" bigint NOT NULL,
	"context_snapshot_id" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"duration_ms" bigint NOT NULL,
	"created_by_user_id" text,
	"selected_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"http_status" bigint,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types_json" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_banned_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"phrase" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_compliance" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"postal_address" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_email_senders" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"from_local_part" text NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"provider_domain_id" text,
	"dns_records_json" text DEFAULT '[]' NOT NULL,
	"kill_switch" boolean DEFAULT true NOT NULL,
	"daily_cap" bigint DEFAULT 100 NOT NULL,
	"last_checked_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"analytics_opt_out" boolean DEFAULT false NOT NULL,
	"website_url" text,
	"onboarding_step" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_metrics" ADD CONSTRAINT "ad_campaign_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_metrics" ADD CONSTRAINT "ad_campaign_metrics_ad_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("ad_campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launch_decisions" ADD CONSTRAINT "ad_launch_decisions_launch_id_ad_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."ad_launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launch_decisions" ADD CONSTRAINT "ad_launch_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_creative_draft_id_drafts_id_fk" FOREIGN KEY ("creative_draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_launches" ADD CONSTRAINT "ad_launches_ad_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("ad_campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_settings" ADD CONSTRAINT "ad_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_rule_id_preference_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."preference_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_schedules" ADD CONSTRAINT "background_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_workspace_dispatch" ADD CONSTRAINT "background_workspace_dispatch_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_document_versions" ADD CONSTRAINT "brain_document_versions_document_id_brain_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."brain_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_documents" ADD CONSTRAINT "brain_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audiences" ADD CONSTRAINT "campaign_audiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audiences" ADD CONSTRAINT "campaign_audiences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audiences" ADD CONSTRAINT "campaign_audiences_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_lane_id_campaign_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."campaign_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_plan_revision_id_campaign_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."campaign_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lane_revisions" ADD CONSTRAINT "campaign_lane_revisions_publishing_connection_id_connections_id_fk" FOREIGN KEY ("publishing_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lanes" ADD CONSTRAINT "campaign_lanes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lanes" ADD CONSTRAINT "campaign_lanes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_canonical_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("canonical_story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_manual_signal_id_signals_id_fk" FOREIGN KEY ("manual_signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_plan_revision_id_campaign_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."campaign_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_routing_profile_id_campaign_routing_profiles_id_fk" FOREIGN KEY ("routing_profile_id") REFERENCES "public"."campaign_routing_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunity_events" ADD CONSTRAINT "campaign_opportunity_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunity_events" ADD CONSTRAINT "campaign_opportunity_events_opportunity_id_campaign_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."campaign_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_plan_revisions" ADD CONSTRAINT "campaign_plan_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_plan_revisions" ADD CONSTRAINT "campaign_plan_revisions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_plan_revisions" ADD CONSTRAINT "campaign_plan_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_routing_profiles" ADD CONSTRAINT "campaign_routing_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_routing_profiles" ADD CONSTRAINT "campaign_routing_profiles_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_routing_profiles" ADD CONSTRAINT "campaign_routing_profiles_plan_revision_id_campaign_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."campaign_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_external_stories" ADD CONSTRAINT "canonical_external_stories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_story_keys" ADD CONSTRAINT "canonical_story_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_story_keys" ADD CONSTRAINT "canonical_story_keys_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_package_events" ADD CONSTRAINT "content_package_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_package_events" ADD CONSTRAINT "content_package_events_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_plan_revision_id_campaign_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."campaign_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_opportunity_id_campaign_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."campaign_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_canonical_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("canonical_story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_matrix_overrides" ADD CONSTRAINT "context_matrix_overrides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_settings" ADD CONSTRAINT "crm_sync_settings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_settings" ADD CONSTRAINT "crm_sync_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_events" ADD CONSTRAINT "deliverable_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_events" ADD CONSTRAINT "deliverable_events_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_plan_revision_id_campaign_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."campaign_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_lane_id_campaign_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."campaign_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_lane_revision_id_campaign_lane_revisions_id_fk" FOREIGN KEY ("lane_revision_id") REFERENCES "public"."campaign_lane_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_overlays" ADD CONSTRAINT "design_overlays_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_overlays" ADD CONSTRAINT "design_overlays_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_overlays" ADD CONSTRAINT "design_overlays_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_overlays" ADD CONSTRAINT "design_overlays_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_item_matches" ADD CONSTRAINT "discovered_item_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_item_matches" ADD CONSTRAINT "discovered_item_matches_item_id_discovered_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."discovered_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_item_matches" ADD CONSTRAINT "discovered_item_matches_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_item_matches" ADD CONSTRAINT "discovered_item_matches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_items" ADD CONSTRAINT "discovered_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_items" ADD CONSTRAINT "discovered_items_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_source_occurrences" ADD CONSTRAINT "discovery_source_occurrences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revision_turns" ADD CONSTRAINT "draft_revision_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revision_turns" ADD CONSTRAINT "draft_revision_turns_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revision_turns" ADD CONSTRAINT "draft_revision_turns_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery_events" ADD CONSTRAINT "email_delivery_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery_events" ADD CONSTRAINT "email_delivery_events_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_recipient_permissions" ADD CONSTRAINT "email_recipient_permissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_metrics" ADD CONSTRAINT "engagement_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_source_draft_id_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_definition_id_pipeline_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."pipeline_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_candidates" ADD CONSTRAINT "evidence_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_collections" ADD CONSTRAINT "evidence_collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_batch_items" ADD CONSTRAINT "external_action_batch_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_batch_items" ADD CONSTRAINT "external_action_batch_items_batch_id_external_action_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."external_action_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_batch_items" ADD CONSTRAINT "external_action_batch_items_action_id_external_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."external_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_batches" ADD CONSTRAINT "external_action_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_batches" ADD CONSTRAINT "external_action_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_decisions" ADD CONSTRAINT "external_action_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_decisions" ADD CONSTRAINT "external_action_decisions_action_id_external_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."external_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_decisions" ADD CONSTRAINT "external_action_decisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_policy_rules" ADD CONSTRAINT "external_action_policy_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action_policy_rules" ADD CONSTRAINT "external_action_policy_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_lane_revision_id_campaign_lane_revisions_id_fk" FOREIGN KEY ("lane_revision_id") REFERENCES "public"."campaign_lane_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_settings" ADD CONSTRAINT "generation_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_overrides" ADD CONSTRAINT "guidance_overrides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_overrides" ADD CONSTRAINT "guidance_overrides_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_overrides" ADD CONSTRAINT "guidance_overrides_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_launch_message_id_launch_messages_id_fk" FOREIGN KEY ("launch_message_id") REFERENCES "public"."launch_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_reply_draft_id_drafts_id_fk" FOREIGN KEY ("reply_draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_email_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("email_delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_eligibility_decisions" ADD CONSTRAINT "lane_eligibility_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_eligibility_decisions" ADD CONSTRAINT "lane_eligibility_decisions_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_eligibility_decisions" ADD CONSTRAINT "lane_eligibility_decisions_assessment_id_sufficiency_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."sufficiency_assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_eligibility_decisions" ADD CONSTRAINT "lane_eligibility_decisions_lane_id_campaign_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."campaign_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_eligibility_decisions" ADD CONSTRAINT "lane_eligibility_decisions_lane_revision_id_campaign_lane_revisions_id_fk" FOREIGN KEY ("lane_revision_id") REFERENCES "public"."campaign_lane_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_sequence_recipient_id_sequence_recipients_id_fk" FOREIGN KEY ("sequence_recipient_id") REFERENCES "public"."sequence_recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_messages" ADD CONSTRAINT "launch_messages_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_x_connection_id_connections_id_fk" FOREIGN KEY ("x_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_default_persona_id_personas_id_fk" FOREIGN KEY ("default_persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_contacts" ADD CONSTRAINT "media_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "now_syntheses" ADD CONSTRAINT "now_syntheses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_enrollments" ADD CONSTRAINT "outreach_enrollments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_enrollments" ADD CONSTRAINT "outreach_enrollments_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_enrollments" ADD CONSTRAINT "outreach_enrollments_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_enrollment_id_outreach_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."outreach_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequence_mailboxes" ADD CONSTRAINT "outreach_sequence_mailboxes_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequence_mailboxes" ADD CONSTRAINT "outreach_sequence_mailboxes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequence_steps" ADD CONSTRAINT "outreach_sequence_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequence_steps" ADD CONSTRAINT "outreach_sequence_steps_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_tracking_events" ADD CONSTRAINT "outreach_tracking_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_tracking_events" ADD CONSTRAINT "outreach_tracking_events_email_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("email_delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_sources" ADD CONSTRAINT "package_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_sources" ADD CONSTRAINT "package_sources_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_sources" ADD CONSTRAINT "package_sources_canonical_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("canonical_story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_sources" ADD CONSTRAINT "package_sources_occurrence_id_discovery_source_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."discovery_source_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_sources" ADD CONSTRAINT "package_sources_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_social_accounts" ADD CONSTRAINT "persona_social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_social_accounts" ADD CONSTRAINT "persona_social_accounts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_social_accounts" ADD CONSTRAINT "persona_social_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definition_versions" ADD CONSTRAINT "pipeline_definition_versions_definition_id_pipeline_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."pipeline_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definition_versions" ADD CONSTRAINT "pipeline_definition_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definitions" ADD CONSTRAINT "pipeline_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definitions" ADD CONSTRAINT "pipeline_definitions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definitions" ADD CONSTRAINT "pipeline_definitions_lane_id_campaign_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."campaign_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definitions" ADD CONSTRAINT "pipeline_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_rollout_decisions" ADD CONSTRAINT "pipeline_rollout_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_rollout_decisions" ADD CONSTRAINT "pipeline_rollout_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" ADD CONSTRAINT "pipeline_run_steps_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" ADD CONSTRAINT "pipeline_run_steps_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_definition_id_pipeline_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."pipeline_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_lane_id_campaign_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."campaign_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_shadow_pairs" ADD CONSTRAINT "pipeline_shadow_pairs_verdict_by_user_id_users_id_fk" FOREIGN KEY ("verdict_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_cadences" ADD CONSTRAINT "posting_cadences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_cadences" ADD CONSTRAINT "posting_cadences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_cadences" ADD CONSTRAINT "posting_cadences_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_cadences" ADD CONSTRAINT "posting_cadences_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_edits" ADD CONSTRAINT "preference_edits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_edits" ADD CONSTRAINT "preference_edits_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rule_evidence" ADD CONSTRAINT "preference_rule_evidence_rule_id_preference_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."preference_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rule_evidence" ADD CONSTRAINT "preference_rule_evidence_edit_id_preference_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."preference_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rules" ADD CONSTRAINT "preference_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_metrics" ADD CONSTRAINT "publication_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_metrics" ADD CONSTRAINT "publication_metrics_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_external_action_id_external_actions_id_fk" FOREIGN KEY ("external_action_id") REFERENCES "public"."external_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_cadence_id_posting_cadences_id_fk" FOREIGN KEY ("cadence_id") REFERENCES "public"."posting_cadences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_recipients" ADD CONSTRAINT "sequence_recipients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_recipients" ADD CONSTRAINT "sequence_recipients_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_automation_settings" ADD CONSTRAINT "social_automation_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_enrichments" ADD CONSTRAINT "story_enrichments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_enrichments" ADD CONSTRAINT "story_enrichments_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_occurrences" ADD CONSTRAINT "story_occurrences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_occurrences" ADD CONSTRAINT "story_occurrences_story_id_canonical_external_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."canonical_external_stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_occurrences" ADD CONSTRAINT "story_occurrences_occurrence_id_discovery_source_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."discovery_source_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sufficiency_assessments" ADD CONSTRAINT "sufficiency_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sufficiency_assessments" ADD CONSTRAINT "sufficiency_assessments_package_id_content_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."content_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_social_accounts" ADD CONSTRAINT "tracked_social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_context_snapshot_id_context_snapshots_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_banned_claims" ADD CONSTRAINT "workspace_banned_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_compliance" ADD CONSTRAINT "workspace_compliance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_email_senders" ADD CONSTRAINT "workspace_email_senders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_workspace_external" ON "ad_accounts" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaign_metrics_campaign_date" ON "ad_campaign_metrics" USING btree ("ad_campaign_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_account_external" ON "ad_campaigns" USING btree ("ad_account_id","external_id");--> statement-breakpoint
CREATE INDEX "ad_launches_external_action" ON "ad_launches" USING btree ("external_action_id");--> statement-breakpoint
CREATE INDEX "agent_proposals_workspace_created" ON "agent_proposals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposals_run" ON "agent_proposals" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_questions_workspace_status" ON "agent_questions" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_questions_pipeline_run" ON "agent_questions" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "agent_questions_run" ON "agent_questions" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_index" ON "agent_run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_started" ON "agent_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_action_tokens_hash" ON "approval_action_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "audience_members_unique" ON "audience_members" USING btree ("audience_id","member_type","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_active_key_unique" ON "background_jobs" USING btree ("active_key");--> statement-breakpoint
CREATE INDEX "background_jobs_status_available" ON "background_jobs" USING btree ("status","available_at","priority","created_at");--> statement-breakpoint
CREATE INDEX "background_jobs_workspace_status" ON "background_jobs" USING btree ("workspace_id","status","available_at");--> statement-breakpoint
CREATE INDEX "background_jobs_lease_expiry" ON "background_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_schedules_workspace_kind_unique" ON "background_schedules" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "background_schedules_due" ON "background_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_documents_workspace_doc_type" ON "brain_documents" USING btree ("workspace_id","doc_type");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_profiles_workspace" ON "brand_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_audiences_unique" ON "campaign_audiences" USING btree ("campaign_id","audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_lane_plan_revision" ON "campaign_lane_revisions" USING btree ("lane_id","plan_revision_id");--> statement-breakpoint
CREATE INDEX "campaign_lane_revision_plan" ON "campaign_lane_revisions" USING btree ("plan_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_lane_key" ON "campaign_lanes" USING btree ("campaign_id","key");--> statement-breakpoint
CREATE INDEX "campaign_lane_workspace_campaign" ON "campaign_lanes" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_opportunities_story_identity" ON "campaign_opportunities" USING btree ("canonical_story_id","campaign_id","plan_revision_id","angle_hash","matcher_version") WHERE "campaign_opportunities"."canonical_story_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_opportunities_signal_identity" ON "campaign_opportunities" USING btree ("manual_signal_id","campaign_id","plan_revision_id","angle_hash","matcher_version") WHERE "campaign_opportunities"."manual_signal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_opportunities_workspace_status" ON "campaign_opportunities" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "campaign_opportunities_story" ON "campaign_opportunities" USING btree ("canonical_story_id");--> statement-breakpoint
CREATE INDEX "campaign_opportunities_campaign_status" ON "campaign_opportunities" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_opportunity_events_opportunity" ON "campaign_opportunity_events" USING btree ("opportunity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_plan_revision_number" ON "campaign_plan_revisions" USING btree ("campaign_id","revision");--> statement-breakpoint
CREATE INDEX "campaign_plan_workspace_campaign" ON "campaign_plan_revisions" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_routing_profiles_identity" ON "campaign_routing_profiles" USING btree ("campaign_id","plan_revision_id","profile_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_routing_profiles_version" ON "campaign_routing_profiles" USING btree ("campaign_id","profile_version");--> statement-breakpoint
CREATE INDEX "campaign_routing_profiles_workspace" ON "campaign_routing_profiles" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE INDEX "canonical_stories_workspace_status" ON "canonical_external_stories" USING btree ("workspace_id","status","last_observed_at");--> statement-breakpoint
CREATE INDEX "canonical_stories_routing_queue" ON "canonical_external_stories" USING btree ("workspace_id","routing_state","routing_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_story_keys_identity" ON "canonical_story_keys" USING btree ("workspace_id","key_kind","key_hash");--> statement-breakpoint
CREATE INDEX "canonical_story_keys_story" ON "canonical_story_keys" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "chat_messages_session_created" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_pins_session" ON "chat_pins" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_pins_session_kind_ref" ON "chat_pins" USING btree ("session_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "chat_proposals_session_created" ON "chat_proposals" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_proposals_workspace_created" ON "chat_proposals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_workspace_user" ON "chat_sessions" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "content_package_events_package" ON "content_package_events" USING btree ("package_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_packages_opportunity" ON "content_packages" USING btree ("opportunity_id") WHERE "content_packages"."opportunity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "content_packages_workspace_status" ON "content_packages" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "content_packages_campaign_status" ON "content_packages" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "content_packages_campaign_angle" ON "content_packages" USING btree ("campaign_id","angle_hash");--> statement-breakpoint
CREATE INDEX "content_packages_assessment_queue" ON "content_packages" USING btree ("workspace_id","assessment_state","assessment_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "context_matrix_overrides_workspace_task_doc" ON "context_matrix_overrides" USING btree ("workspace_id","task_type","doc_type");--> statement-breakpoint
CREATE INDEX "context_snapshots_deliverable" ON "context_snapshots" USING btree ("deliverable_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_connection_external" ON "crm_contacts" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "deliverable_events_deliverable" ON "deliverable_events" USING btree ("deliverable_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverables_planned_slot" ON "deliverables" USING btree ("lane_revision_id","original_scheduled_for") WHERE "deliverables"."original_scheduled_for" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deliverables_reactive_package" ON "deliverables" USING btree ("package_id","lane_revision_id") WHERE "deliverables"."kind" = 'reactive' AND "deliverables"."package_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deliverables_workspace_status" ON "deliverables" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "deliverables_lane_revision" ON "deliverables" USING btree ("lane_revision_id","status");--> statement-breakpoint
CREATE INDEX "deliverables_package" ON "deliverables" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "deliverables_campaign_status" ON "deliverables" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "deliverables_generation_queue" ON "deliverables" USING btree ("workspace_id","generation_state","generation_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "design_overlays_system_channel_scope" ON "design_overlays" USING btree ("design_system_id","channel","persona_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_systems_workspace_name" ON "design_systems" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "design_templates_lookup" ON "design_templates" USING btree ("workspace_id","design_system_id","skill_id","design_system_fingerprint","slide_shape");--> statement-breakpoint
CREATE INDEX "discovered_item_matches_item" ON "discovered_item_matches" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_items_source_external" ON "discovered_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "discovered_items_workspace_url_hash" ON "discovered_items" USING btree ("workspace_id","url_hash");--> statement-breakpoint
CREATE INDEX "discovered_items_workspace_content_hash" ON "discovered_items" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "discovered_items_matching_queue" ON "discovered_items" USING btree ("matching_state","matching_lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "discovery_jobs_workspace_status" ON "discovery_jobs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "discovery_jobs_source_status" ON "discovery_jobs" USING btree ("source_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_jobs_one_active_source" ON "discovery_jobs" USING btree ("source_id") WHERE "discovery_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_source_occurrences_source_external" ON "discovery_source_occurrences" USING btree ("source_id","provider_external_id");--> statement-breakpoint
CREATE INDEX "discovery_source_occurrences_workspace_observed" ON "discovery_source_occurrences" USING btree ("workspace_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_revision_turn_request" ON "draft_revision_turns" USING btree ("draft_id","request_id");--> statement-breakpoint
CREATE INDEX "draft_revision_turn_draft" ON "draft_revision_turns" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_automation_key" ON "drafts" USING btree ("automation_key") WHERE "drafts"."automation_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_workspace_idempotency" ON "email_deliveries" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_provider_message" ON "email_deliveries" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_workspace_status_accepted" ON "email_deliveries" USING btree ("workspace_id","status","accepted_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_workspace_origin" ON "email_deliveries" USING btree ("workspace_id","origin","origin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_events_provider_event" ON "email_delivery_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "email_delivery_events_delivery_created" ON "email_delivery_events" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_recipient_permissions_workspace_email" ON "email_recipient_permissions" USING btree ("workspace_id","normalized_email");--> statement-breakpoint
CREATE INDEX "email_recipient_permissions_workspace_status" ON "email_recipient_permissions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_workspace_email" ON "email_suppressions" USING btree ("workspace_id","normalized_email");--> statement-breakpoint
CREATE INDEX "email_suppressions_workspace_created" ON "email_suppressions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_case_results_run" ON "eval_case_results" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_cases_suite" ON "eval_cases" USING btree ("suite_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_runs_baseline_label" ON "eval_runs" USING btree ("workspace_id","baseline_label") WHERE "eval_runs"."baseline_label" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "eval_runs_workspace" ON "eval_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_suites_workspace" ON "eval_suites" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_candidates_source" ON "evidence_candidates" USING btree ("workspace_id","kind","source_ref");--> statement-breakpoint
CREATE INDEX "evidence_chunks_collection" ON "evidence_chunks" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_document" ON "evidence_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_fts" ON "evidence_chunks" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "evidence_chunks_embedding" ON "evidence_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "external_action_batch_items_batch_action" ON "external_action_batch_items" USING btree ("batch_id","action_id");--> statement-breakpoint
CREATE INDEX "external_action_batch_items_workspace_batch" ON "external_action_batch_items" USING btree ("workspace_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_action_batches_workspace_request" ON "external_action_batches" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "external_action_batches_workspace_status" ON "external_action_batches" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "external_action_decisions_action" ON "external_action_decisions" USING btree ("action_id","created_at");--> statement-breakpoint
CREATE INDEX "external_action_decisions_workspace" ON "external_action_decisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_action_policy_scope_kind" ON "external_action_policy_rules" USING btree ("workspace_id","scope","scope_id","action_kind");--> statement-breakpoint
CREATE INDEX "external_action_policy_workspace_scope" ON "external_action_policy_rules" USING btree ("workspace_id","scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_actions_workspace_idempotency" ON "external_actions" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "external_actions_workspace_status" ON "external_actions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "external_actions_workspace_subject" ON "external_actions" USING btree ("workspace_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "external_actions_campaign" ON "external_actions" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guidance_overrides_workspace_channel_scope" ON "guidance_overrides" USING btree ("workspace_id","channel","persona_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_connection_external" ON "inbox_items" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "inbox_items_external_action" ON "inbox_items" USING btree ("external_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_eligibility_identity" ON "lane_eligibility_decisions" USING btree ("package_id","assessment_id","lane_revision_id");--> statement-breakpoint
CREATE INDEX "lane_eligibility_package" ON "lane_eligibility_decisions" USING btree ("package_id","created_at");--> statement-breakpoint
CREATE INDEX "launch_messages_external_action" ON "launch_messages" USING btree ("external_action_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_workspace_created" ON "llm_usage_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_events_workspace_pipeline" ON "llm_usage_events" USING btree ("workspace_id","pipeline","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_workspace_address" ON "mailboxes" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "mailboxes_workspace_status" ON "mailboxes" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_grain" ON "metrics" USING btree ("workspace_id","subject_type","subject_id","metric_key","window","period_start");--> statement-breakpoint
CREATE INDEX "metrics_workspace_subject" ON "metrics" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_enrollments_sequence_recipient" ON "outreach_enrollments" USING btree ("sequence_id","recipient_type","recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_enrollments_active_person" ON "outreach_enrollments" USING btree ("workspace_id","recipient_type","recipient_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "outreach_enrollments_due" ON "outreach_enrollments" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_messages_enrollment_step" ON "outreach_messages" USING btree ("enrollment_id","step_number");--> statement-breakpoint
CREATE INDEX "outreach_sequence_mailboxes_mailbox" ON "outreach_sequence_mailboxes" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_steps_sequence_number" ON "outreach_sequence_steps" USING btree ("sequence_id","step_number");--> statement-breakpoint
CREATE INDEX "outreach_tracking_events_delivery" ON "outreach_tracking_events" USING btree ("email_delivery_id");--> statement-breakpoint
CREATE INDEX "package_sources_package" ON "package_sources" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_social_accounts_unique" ON "persona_social_accounts" USING btree ("persona_id","connection_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_definition_versions_version" ON "pipeline_definition_versions" USING btree ("definition_id","version");--> statement-breakpoint
CREATE INDEX "pipeline_definitions_workspace_task" ON "pipeline_definitions" USING btree ("workspace_id","task_key","status");--> statement-breakpoint
CREATE INDEX "pipeline_rollout_decisions_workspace" ON "pipeline_rollout_decisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_steps_attempt" ON "pipeline_run_steps" USING btree ("run_id","step_key","iteration","attempt");--> statement-breakpoint
CREATE INDEX "pipeline_run_steps_run" ON "pipeline_run_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_idempotency" ON "pipeline_runs" USING btree ("workspace_id","idempotency_key") WHERE "pipeline_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pipeline_runs_workspace_status" ON "pipeline_runs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_definition" ON "pipeline_runs" USING btree ("definition_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_batch" ON "pipeline_runs" USING btree ("dry_run_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_shadow_pairs_key" ON "pipeline_shadow_pairs" USING btree ("pair_key");--> statement-breakpoint
CREATE INDEX "pipeline_shadow_pairs_workspace" ON "pipeline_shadow_pairs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "preference_edit_source" ON "preference_edits" USING btree ("workspace_id","source","source_id");--> statement-breakpoint
CREATE INDEX "preference_edit_undigested" ON "preference_edits" USING btree ("workspace_id","digested_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "preference_rule_evidence_pair" ON "preference_rule_evidence" USING btree ("rule_id","edit_id");--> statement-breakpoint
CREATE INDEX "preference_rule_workspace" ON "preference_rules" USING btree ("workspace_id","status","confidence");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_metrics_pub_window" ON "publication_metrics" USING btree ("publication_id","window");--> statement-breakpoint
CREATE INDEX "publications_external_action" ON "publications" USING btree ("external_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_recipients_unique" ON "sequence_recipients" USING btree ("launch_id","channel","recipient_type","recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_launch_channel_step" ON "sequence_steps" USING btree ("launch_id","channel","step_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "signal_matches_signal" ON "signal_matches" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signal_matches_signal_campaign" ON "signal_matches" USING btree ("signal_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "story_enrichments_identity" ON "story_enrichments" USING btree ("story_id","story_fingerprint","enricher_version");--> statement-breakpoint
CREATE UNIQUE INDEX "story_occurrences_one_active" ON "story_occurrences" USING btree ("occurrence_id") WHERE "story_occurrences"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX "story_occurrences_story" ON "story_occurrences" USING btree ("story_id","detached_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_workspace" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sufficiency_assessments_version" ON "sufficiency_assessments" USING btree ("package_id","assessment_version");--> statement-breakpoint
CREATE INDEX "sufficiency_assessments_package" ON "sufficiency_assessments" USING btree ("package_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_social_account_unique" ON "tracked_social_accounts" USING btree ("workspace_id","platform","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_version" ON "variants" USING btree ("deliverable_id","variant_version");--> statement-breakpoint
CREATE INDEX "variants_deliverable_status" ON "variants" USING btree ("deliverable_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_banned_claims_phrase" ON "workspace_banned_claims" USING btree ("workspace_id","phrase");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_token" ON "workspace_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user" ON "workspace_members" USING btree ("workspace_id","user_id");