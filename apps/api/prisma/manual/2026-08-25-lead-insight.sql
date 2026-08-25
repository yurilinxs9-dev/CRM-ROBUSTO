-- ALTER TYPE ... ADD VALUE nao roda dentro de transacao: statement isolado.
ALTER TYPE "AiFeature" ADD VALUE IF NOT EXISTS 'insights';

BEGIN;
CREATE TABLE IF NOT EXISTS "LeadInsight" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "lead_id" TEXT NOT NULL UNIQUE REFERENCES "Lead"("id") ON DELETE CASCADE,
  "resumo" TEXT NOT NULL DEFAULT '',
  "memoria" JSONB NOT NULL DEFAULT '[]',
  "proxima_acao_at" TIMESTAMP(3),
  "proxima_acao_motivo" TEXT NOT NULL DEFAULT '',
  "msg_sugerida" TEXT NOT NULL DEFAULT '',
  "ultima_msg_processada_at" TIMESTAMP(3),
  "geracoes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "LeadInsight_tenant_id_idx" ON "LeadInsight"("tenant_id");
CREATE INDEX IF NOT EXISTS "LeadInsight_tenant_id_proxima_acao_at_idx" ON "LeadInsight"("tenant_id", "proxima_acao_at");
COMMIT;
