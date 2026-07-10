-- 20260710_custom_fields — CustomFieldDef (Lead.dados_custom já existe)
-- Aplicar manualmente no Supabase junto com 20260710_auth_sessions.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS "CustomFieldDef" (
  "id"         TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "nome"       TEXT NOT NULL,
  "key"        TEXT NOT NULL,
  "tipo"       TEXT NOT NULL,
  "options"    JSONB,
  "ordem"      INTEGER NOT NULL DEFAULT 0,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomFieldDef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_tenant_id_key_key" ON "CustomFieldDef"("tenant_id", "key");
CREATE INDEX IF NOT EXISTS "CustomFieldDef_tenant_id_active_idx" ON "CustomFieldDef"("tenant_id", "active");

COMMIT;
