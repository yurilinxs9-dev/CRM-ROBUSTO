-- Fase 4 (IA que decide): sugestões de temperatura/etapa na ficha + toggle do tenant.
BEGIN;
ALTER TABLE "LeadInsight"
  ADD COLUMN "temperatura_sugerida" "LeadTemperatura",
  ADD COLUMN "temperatura_justificativa" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "etapa_sugerida_id" TEXT,
  ADD COLUMN "etapa_sugerida_motivo" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "etapa_recusas" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "LeadInsight"
  ADD CONSTRAINT "LeadInsight_etapa_sugerida_id_fkey"
  FOREIGN KEY ("etapa_sugerida_id") REFERENCES "Stage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tenant"
  ADD COLUMN "ia_ajusta_temperatura" BOOLEAN NOT NULL DEFAULT true;
COMMIT;
