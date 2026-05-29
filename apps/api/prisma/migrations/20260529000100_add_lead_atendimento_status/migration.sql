-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "atendimento_status" "ConversationStatus" NOT NULL DEFAULT 'OPEN';

-- CreateIndex
CREATE INDEX "Lead_tenant_id_atendimento_status_idx" ON "Lead"("tenant_id", "atendimento_status");
