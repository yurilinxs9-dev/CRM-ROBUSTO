BEGIN;
ALTER TABLE "Tenant" ADD COLUMN "billing_value" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "billing_cycle_months" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "billing_paid_until" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "suspended_at" TIMESTAMP(3);
-- Backfill: tenant já suspenso (todos os users inativos) ganha marca explícita.
UPDATE "Tenant" t SET "suspended_at" = now()
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id AND u.ativo = true);
COMMIT;
