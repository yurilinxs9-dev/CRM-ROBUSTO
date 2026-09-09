-- apps/api/prisma/migrations/20260908120000_sheet_import_row/migration.sql
-- Importação da planilha Meta Lead Ads: registro de linha já vista.
-- ADITIVO E SÓ: uma tabela nova, sem FK. NENHUM ALTER em tabela existente.
-- Ver docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md.
--
-- Aplicar com:  node scripts/apply-sheet-import.mjs   (cwd = apps/api)
-- As linhas "-- @@SPLIT" separam os statements para o script aplicador.

CREATE TABLE IF NOT EXISTS "SheetImportRow" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "source_row_id" TEXT NOT NULL,
  "lead_id"       TEXT,
  "status"        TEXT NOT NULL,
  "detail"        TEXT,
  "attempts"      INTEGER NOT NULL DEFAULT 1,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SheetImportRow_pkey" PRIMARY KEY ("id")
);
-- @@SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "SheetImportRow_tenant_id_source_row_id_key"
  ON "SheetImportRow"("tenant_id", "source_row_id");
-- @@SPLIT
CREATE INDEX IF NOT EXISTS "SheetImportRow_tenant_id_status_idx"
  ON "SheetImportRow"("tenant_id", "status");
