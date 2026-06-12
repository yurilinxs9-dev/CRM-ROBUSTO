-- F-01/F-02/F-03 — Setores, Round-Robin e Identificação de Remetente.
-- Migration ADITIVA: nenhuma coluna existente é alterada/removida. Todas as
-- novas colunas têm default ou são nullable. Backfill no fim preserva dados.

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('user', 'ai', 'system');

-- AlterTable: novas colunas (todas com default ou nullable)
ALTER TABLE "Tenant" ADD COLUMN "round_robin_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "sector_id" TEXT;
ALTER TABLE "WhatsappInstance" ADD COLUMN "sector_id" TEXT;
ALTER TABLE "Lead" ADD COLUMN "ai_blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "sender_type" "SenderType" NOT NULL DEFAULT 'system';
ALTER TABLE "Message" ADD COLUMN "sender_id" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "is_ai" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Sector" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QueuePointer" (
    "sector_id" TEXT NOT NULL,
    "current_index" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QueuePointer_pkey" PRIMARY KEY ("sector_id")
);

CREATE TABLE "AssignmentLog" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sector_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "user_id" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssignmentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_sector_id_idx" ON "User"("sector_id");
CREATE UNIQUE INDEX "Sector_tenant_id_name_key" ON "Sector"("tenant_id", "name");
CREATE INDEX "Sector_tenant_id_active_idx" ON "Sector"("tenant_id", "active");
CREATE INDEX "AssignmentLog_tenant_id_created_at_idx" ON "AssignmentLog"("tenant_id", "created_at");
CREATE INDEX "AssignmentLog_sector_id_created_at_idx" ON "AssignmentLog"("sector_id", "created_at");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsappInstance" ADD CONSTRAINT "WhatsappInstance_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sector" ADD CONSTRAINT "Sector_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueuePointer" ADD CONSTRAINT "QueuePointer_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "Sector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- BACKFILL (sem perda de dados)
-- ============================================================================

-- 1 setor "Sem Setor" por tenant (idempotente via unique tenant_id+name).
-- gen_random_uuid() é nativo no Postgres 13+ (Supabase = PG15).
INSERT INTO "Sector" ("id", "tenant_id", "name", "active", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'Sem Setor', true, now(), now()
FROM "Tenant" t
ON CONFLICT ("tenant_id", "name") DO NOTHING;

-- Vincula todos os usuários existentes ao "Sem Setor" do seu tenant.
UPDATE "User" u
SET "sector_id" = s."id"
FROM "Sector" s
WHERE s."tenant_id" = u."tenant_id"
  AND s."name" = 'Sem Setor'
  AND u."sector_id" IS NULL;

-- Histórico de mensagens: as enviadas por humano conhecido viram 'user'
-- (o resto permanece 'system', o default). Cosmético para o badge no chat;
-- não afeta a lógica de ai_blocked (que é calculada daqui pra frente).
UPDATE "Message"
SET "sender_type" = 'user', "sender_id" = "sent_by_user_id"
WHERE "sent_by_user_id" IS NOT NULL;
