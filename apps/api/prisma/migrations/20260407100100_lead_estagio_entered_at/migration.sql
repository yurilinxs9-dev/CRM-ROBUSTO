-- Track when a lead entered its current stage (for SLA / max_dias visualization).
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "estagio_entered_at" TIMESTAMP(3);

-- Backfill: assume current stage was entered at the last update time.
UPDATE "Lead" SET "estagio_entered_at" = "updated_at" WHERE "estagio_entered_at" IS NULL;
