-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "base_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "frontmatter_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_modified_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Todo',
    "when_date" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "project" TEXT,
    "domain" TEXT,
    "courses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes_summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "target_date" TIMESTAMP(3),
    "area" TEXT,
    "domain" TEXT,
    "linked_tasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes_summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ideas" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Backburner',
    "domain" TEXT,
    "impact" TEXT,
    "effort" TEXT,
    "idea_created" TIMESTAMP(3),
    "notes_summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meeting_date" TIMESTAMP(3),
    "meeting_type" TEXT,
    "attendees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "project" TEXT,
    "area" TEXT,
    "action_items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decisions" TEXT,
    "notes_summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linked_at" TIMESTAMP(3),
    "lint_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_jobs" (
    "id" TEXT NOT NULL,
    "audio_name" TEXT NOT NULL,
    "audio_size" INTEGER NOT NULL,
    "audio_key" TEXT,
    "audio_files" JSONB,
    "supplementary_files" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT,
    "asr_task_id" TEXT,
    "asr_task_ids" JSONB,
    "asr_chars" INTEGER,
    "pass1_json" TEXT,
    "raw_transcript" TEXT,
    "analysis_json" TEXT,
    "participants_text" TEXT,
    "output_path" TEXT,
    "error" TEXT,
    "opencode_raw_output" TEXT,
    "opencode_session_id" TEXT,
    "opencode_share_url" TEXT,
    "upload_submission_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_entity_effects" (
    "id" TEXT NOT NULL,
    "effect_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "entity_update_id" TEXT NOT NULL,
    "entity_filepath" TEXT NOT NULL,
    "fact_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_entity_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_uploads" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'audio',
    "file_index" INTEGER NOT NULL,
    "original_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "expected_size" INTEGER NOT NULL,
    "s3_key" TEXT,
    "multipart_upload_id" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'single',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "parts" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "field" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "last_seen_hash" TEXT NOT NULL,
    "last_written_hash" TEXT,
    "sync_status" TEXT NOT NULL DEFAULT 'clean',
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caldav_sources" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "display_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ctag" TEXT,
    "sync_token" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caldav_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caldav_objects" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "etag" TEXT,
    "uid" TEXT,
    "summary" TEXT,
    "description" TEXT,
    "location" TEXT,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "raw_ical" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caldav_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caldav_sync_state" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "last_status" TEXT NOT NULL DEFAULT 'idle',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caldav_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_calendar_events" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_suggestions" (
    "id" TEXT NOT NULL,
    "note_id" TEXT,
    "filepath" TEXT NOT NULL,
    "mention" TEXT NOT NULL,
    "suggested_type" TEXT NOT NULL,
    "evidence" TEXT,
    "suggested_existing_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "opencode_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "entity_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_tiers" (
    "tier" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_tiers_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "hermes_session_pins" (
    "id" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hermes_session_pins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notes_filepath_key" ON "notes"("filepath");

-- CreateIndex
CREATE INDEX "notes_base_type_idx" ON "notes"("base_type");

-- CreateIndex
CREATE INDEX "notes_deleted_at_idx" ON "notes"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_note_id_key" ON "tasks"("note_id");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_when_date_idx" ON "tasks"("when_date");

-- CreateIndex
CREATE INDEX "tasks_priority_idx" ON "tasks"("priority");

-- CreateIndex
CREATE INDEX "tasks_project_idx" ON "tasks"("project");

-- CreateIndex
CREATE INDEX "tasks_domain_idx" ON "tasks"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "projects_note_id_key" ON "projects"("note_id");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "projects_area_idx" ON "projects"("area");

-- CreateIndex
CREATE UNIQUE INDEX "ideas_note_id_key" ON "ideas"("note_id");

-- CreateIndex
CREATE INDEX "ideas_status_idx" ON "ideas"("status");

-- CreateIndex
CREATE INDEX "ideas_domain_idx" ON "ideas"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_note_id_key" ON "meetings"("note_id");

-- CreateIndex
CREATE INDEX "meetings_meeting_date_idx" ON "meetings"("meeting_date");

-- CreateIndex
CREATE INDEX "meetings_meeting_type_idx" ON "meetings"("meeting_type");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_jobs_upload_submission_id_key" ON "meeting_jobs"("upload_submission_id");

-- CreateIndex
CREATE INDEX "meeting_jobs_status_idx" ON "meeting_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_entity_effects_effect_id_key" ON "meeting_entity_effects"("effect_id");

-- CreateIndex
CREATE INDEX "meeting_entity_effects_job_id_idx" ON "meeting_entity_effects"("job_id");

-- CreateIndex
CREATE INDEX "meeting_entity_effects_job_id_entity_filepath_fact_hash_idx" ON "meeting_entity_effects"("job_id", "entity_filepath", "fact_hash");

-- CreateIndex
CREATE INDEX "meeting_uploads_status_idx" ON "meeting_uploads"("status");

-- CreateIndex
CREATE INDEX "meeting_uploads_last_activity_at_idx" ON "meeting_uploads"("last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_uploads_job_id_kind_file_index_key" ON "meeting_uploads"("job_id", "kind", "file_index");

-- CreateIndex
CREATE INDEX "task_events_task_id_idx" ON "task_events"("task_id");

-- CreateIndex
CREATE INDEX "task_events_created_at_idx" ON "task_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_note_id_key" ON "sync_state"("note_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "caldav_sources_url_key" ON "caldav_sources"("url");

-- CreateIndex
CREATE INDEX "caldav_objects_start_at_idx" ON "caldav_objects"("start_at");

-- CreateIndex
CREATE INDEX "caldav_objects_uid_idx" ON "caldav_objects"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "caldav_objects_source_id_href_key" ON "caldav_objects"("source_id", "href");

-- CreateIndex
CREATE UNIQUE INDEX "caldav_sync_state_key_key" ON "caldav_sync_state"("key");

-- CreateIndex
CREATE UNIQUE INDEX "local_calendar_events_uid_key" ON "local_calendar_events"("uid");

-- CreateIndex
CREATE INDEX "local_calendar_events_start_at_idx" ON "local_calendar_events"("start_at");

-- CreateIndex
CREATE INDEX "entity_suggestions_status_idx" ON "entity_suggestions"("status");

-- CreateIndex
CREATE INDEX "entity_suggestions_note_id_idx" ON "entity_suggestions"("note_id");

-- CreateIndex
CREATE INDEX "entity_suggestions_filepath_idx" ON "entity_suggestions"("filepath");

-- CreateIndex
CREATE INDEX "entity_suggestions_suggested_type_idx" ON "entity_suggestions"("suggested_type");

-- CreateIndex
CREATE INDEX "hermes_session_pins_profile_created_at_idx" ON "hermes_session_pins"("profile", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hermes_session_pins_profile_session_id_key" ON "hermes_session_pins"("profile", "session_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_uploads" ADD CONSTRAINT "meeting_uploads_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "meeting_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caldav_objects" ADD CONSTRAINT "caldav_objects_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "caldav_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_suggestions" ADD CONSTRAINT "entity_suggestions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

