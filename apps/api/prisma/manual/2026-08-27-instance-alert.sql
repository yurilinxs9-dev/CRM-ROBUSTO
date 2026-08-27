-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Monitor de instancias: alerta aberto quando um numero cai, fechado ao voltar.
BEGIN;

CREATE TABLE IF NOT EXISTS "InstanceAlert" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "instance_id" TEXT NOT NULL,
  "tipo" TEXT NOT NULL DEFAULT 'desconectada',
  "aberto_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvido_em" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstanceAlert_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstanceAlert_tenant_id_fkey') THEN
    ALTER TABLE "InstanceAlert" ADD CONSTRAINT "InstanceAlert_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstanceAlert_instance_id_fkey') THEN
    ALTER TABLE "InstanceAlert" ADD CONSTRAINT "InstanceAlert_instance_id_fkey"
      FOREIGN KEY ("instance_id") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "InstanceAlert_instance_id_resolvido_em_idx" ON "InstanceAlert"("instance_id", "resolvido_em");
CREATE INDEX IF NOT EXISTS "InstanceAlert_resolvido_em_aberto_em_idx" ON "InstanceAlert"("resolvido_em", "aberto_em");

COMMIT;
