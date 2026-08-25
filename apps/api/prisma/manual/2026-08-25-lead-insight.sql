-- Aplicar via psql -f (ou em DOIS comandos: o ALTER TYPE isolado primeiro, depois o bloco BEGIN..COMMIT).

-- Desde o PG 12 o ALTER TYPE ... ADD VALUE roda dentro de transacao; o que
-- continua proibido e USAR o valor novo na mesma transacao que o adicionou.
-- Mantido como statement isolado, antes do BEGIN, por seguranca.
ALTER TYPE "AiFeature" ADD VALUE IF NOT EXISTS 'insights';

BEGIN;
-- ON UPDATE CASCADE e o default do Prisma p/ onUpdate: sem ele a introspeccao
-- acusa drift (padrao em todas as FKs das migrations do repo).
CREATE TABLE IF NOT EXISTS "LeadInsight" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "lead_id" TEXT NOT NULL UNIQUE REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE,
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
