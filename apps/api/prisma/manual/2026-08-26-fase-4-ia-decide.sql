-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Fase 4 (IA que decide): sugestões de temperatura/etapa na ficha + toggle do tenant.
-- O enum "LeadTemperatura" (FRIO/MORNO/QUENTE/MUITO_QUENTE) já existe: só é referenciado.
BEGIN;

ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "temperatura_sugerida" "LeadTemperatura";
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "temperatura_justificativa" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "etapa_sugerida_id" TEXT;
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "etapa_sugerida_motivo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LeadInsight" ADD COLUMN IF NOT EXISTS "etapa_recusas" JSONB NOT NULL DEFAULT '[]';

-- Postgres não tem ADD CONSTRAINT IF NOT EXISTS: guarda pelo catálogo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LeadInsight_etapa_sugerida_id_fkey'
  ) THEN
    ALTER TABLE "LeadInsight"
      ADD CONSTRAINT "LeadInsight_etapa_sugerida_id_fkey"
      FOREIGN KEY ("etapa_sugerida_id") REFERENCES "Stage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "ia_ajusta_temperatura" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
