-- LeadView: filtros salvos da lista de leads.
--
-- SQL escrita à mão, só-de-objetos-novos. `prisma migrate diff` neste banco
-- arrastaria o drift pré-existente (FKs de Lead/InstanceHidden/PushSubscription
-- e o tipo de Lead.assumed_at) para dentro da migration — ver CLAUDE.md.
--
-- Aplicar em transação e registrar com:
--   prisma migrate resolve --applied 20260807120000_add_lead_view
-- NUNCA `prisma migrate deploy` aqui: o _prisma_migrations tem ~47 linhas com
-- finished_at nulo e o comando falha com P3009 antes de chegar nesta.

CREATE TABLE IF NOT EXISTS "LeadView" (
    "id"         TEXT NOT NULL,
    "nome"       TEXT NOT NULL,
    "filtros"    JSONB NOT NULL DEFAULT '{}',
    "user_id"    TEXT,
    "tenant_id"  TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadView_tenant_id_idx" ON "LeadView"("tenant_id");
CREATE INDEX IF NOT EXISTS "LeadView_tenant_id_user_id_idx" ON "LeadView"("tenant_id", "user_id");

-- ON DELETE CASCADE nos dois: view é configuração de tela, não dado de
-- negócio. Apagar o tenant ou o usuário leva junto as views dele, em vez de
-- deixar linha órfã apontando para id que não existe mais.
ALTER TABLE "LeadView"
    ADD CONSTRAINT "LeadView_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadView"
    ADD CONSTRAINT "LeadView_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
