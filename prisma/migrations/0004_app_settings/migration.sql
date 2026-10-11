-- Runtime-editable settings; secrets are supplied by the adopter at runtime.
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
