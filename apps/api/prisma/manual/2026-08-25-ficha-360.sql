-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Colunas novas da ficha 360 em LeadInsight (spec 2026-08-25-ficha-360).
-- Aditivas: nenhuma FK envolvida, tabela ja criada em 2026-08-25-lead-insight.sql.
BEGIN;
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "nota_atendimento" INTEGER;
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "nota_ponto_forte" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "nota_ponto_melhoria" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "ultima_compra" JSONB;
COMMIT;
