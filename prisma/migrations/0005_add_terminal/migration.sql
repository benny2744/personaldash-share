-- Web terminal host registry and session audit metadata.
CREATE TABLE IF NOT EXISTS "terminal_hosts" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "ssh_host" TEXT NOT NULL,
  "ssh_port" INTEGER NOT NULL DEFAULT 22,
  "ssh_user" TEXT NOT NULL,
  "credential_ref" TEXT NOT NULL DEFAULT 'default',
  "host_key_sha256" TEXT,
  "allowed_identities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "terminal_hosts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "terminal_hosts_slug_key"
  ON "terminal_hosts"("slug");

CREATE TABLE IF NOT EXISTS "terminal_sessions" (
  "id" TEXT NOT NULL,
  "identity" TEXT NOT NULL,
  "host_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "client_meta" JSONB,
  "bytes_in" BIGINT NOT NULL DEFAULT 0,
  "bytes_out" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connected_at" TIMESTAMP(3),
  "last_activity_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "close_reason" TEXT,
  CONSTRAINT "terminal_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "terminal_sessions_identity_status_idx"
  ON "terminal_sessions"("identity", "status");
CREATE INDEX IF NOT EXISTS "terminal_sessions_host_id_status_idx"
  ON "terminal_sessions"("host_id", "status");
CREATE INDEX IF NOT EXISTS "terminal_sessions_created_at_idx"
  ON "terminal_sessions"("created_at");

DO $$ BEGIN
  ALTER TABLE "terminal_sessions"
    ADD CONSTRAINT "terminal_sessions_host_id_fkey"
    FOREIGN KEY ("host_id") REFERENCES "terminal_hosts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
