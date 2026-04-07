-- Idempotent creation of Task table + supporting enums.
-- Task model exists in schema.prisma but never had a dedicated migration.

DO $$ BEGIN
  CREATE TYPE "TaskType" AS ENUM ('FOLLOW_UP', 'LIGACAO', 'REUNIAO', 'EMAIL', 'VISITA', 'OUTRO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('PENDENTE', 'CONCLUIDA', 'CANCELADA', 'ATRASADA');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "Prioridade" AS ENUM ('BAIXA', 'MEDIA', 'ALTA', 'URGENTE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "Task" (
  "id"             TEXT NOT NULL,
  "titulo"         TEXT NOT NULL,
  "descricao"      TEXT,
  "tipo"           "TaskType"   NOT NULL DEFAULT 'FOLLOW_UP',
  "status"         "TaskStatus" NOT NULL DEFAULT 'PENDENTE',
  "prioridade"     "Prioridade" NOT NULL DEFAULT 'MEDIA',
  "scheduled_at"   TIMESTAMP(3) NOT NULL,
  "completed_at"   TIMESTAMP(3),
  "duracao_min"    INTEGER,
  "lead_id"        TEXT,
  "responsavel_id" TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Task_scheduled_at_idx" ON "Task" ("scheduled_at");
CREATE INDEX IF NOT EXISTS "Task_responsavel_id_status_idx" ON "Task" ("responsavel_id", "status");
CREATE INDEX IF NOT EXISTS "Task_lead_id_idx" ON "Task" ("lead_id");
CREATE INDEX IF NOT EXISTS "Task_tenant_id_idx" ON "Task" ("tenant_id");

DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_responsavel_id_fkey"
    FOREIGN KEY ("responsavel_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
