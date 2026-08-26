-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Fase 3 (lembretes temporais): marcos ditos pelo cliente viram aviso na data.
BEGIN;

CREATE TABLE IF NOT EXISTS "LeadLembrete" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "motivo" TEXT NOT NULL,
  "dito_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "avisar_em" TIMESTAMP(3) NOT NULL,
  "origem" TEXT NOT NULL DEFAULT 'ia',
  "status" TEXT NOT NULL DEFAULT 'pendente',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LeadLembrete_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadLembrete_tenant_id_fkey') THEN
    ALTER TABLE "LeadLembrete" ADD CONSTRAINT "LeadLembrete_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadLembrete_lead_id_fkey') THEN
    ALTER TABLE "LeadLembrete" ADD CONSTRAINT "LeadLembrete_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "LeadLembrete_tenant_id_status_avisar_em_idx" ON "LeadLembrete"("tenant_id", "status", "avisar_em");
CREATE INDEX IF NOT EXISTS "LeadLembrete_lead_id_status_idx" ON "LeadLembrete"("lead_id", "status");

COMMIT;
