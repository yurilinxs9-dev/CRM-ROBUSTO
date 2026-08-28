-- Modo individual redondo (spec 2026-08-28). Aditiva, segura com backend
-- velho no ar. Aplicar via DIRECT_URL (pooler transaction-mode dá 25001).
BEGIN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "focus_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "returned_at" TIMESTAMP(3);
COMMIT;
