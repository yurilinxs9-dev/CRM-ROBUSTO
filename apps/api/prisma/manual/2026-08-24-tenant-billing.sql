BEGIN;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "billing_value" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "billing_cycle_months" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "billing_paid_until" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP(3);
-- Backfill: tenant já suspenso (todos os users inativos) ganha marca explícita.
UPDATE "Tenant" t SET "suspended_at" = now() AT TIME ZONE 'UTC'
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id AND u.ativo = true);
COMMIT;
