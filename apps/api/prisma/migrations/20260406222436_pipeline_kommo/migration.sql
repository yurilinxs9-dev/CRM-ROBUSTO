-- Pipeline Kommo upgrade: add visual + lifecycle fields, stage SLA, composite index.

ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "cor"       TEXT DEFAULT '#3b82f6';
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "icone"     TEXT;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "arquivado" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "max_dias" INTEGER;

-- Composite index for tenant-scoped kanban queries
CREATE INDEX IF NOT EXISTS "Lead_tenant_id_pipeline_id_estagio_id_position_idx"
  ON "Lead" ("tenant_id", "pipeline_id", "estagio_id", "position");
