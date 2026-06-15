-- IA nativa + follow-up/broadcast por IA (F1/F2/F3)
-- Apenas objetos novos — não toca em tabelas/FKs existentes.

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('openai_compatible', 'anthropic');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('copilot', 'suggest', 'autoreply', 'followup');

-- CreateEnum
CREATE TYPE "BroadcastMode" AS ENUM ('template', 'ai');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'running', 'paused', 'done', 'canceled');

-- CreateEnum
CREATE TYPE "BroadcastTargetStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "AiModelConfig" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "base_url" TEXT,
    "model_id" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAgentConfig" (
    "id" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "persona" TEXT,
    "copilot_enabled" BOOLEAN NOT NULL DEFAULT true,
    "suggest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoreply_enabled" BOOLEAN NOT NULL DEFAULT false,
    "followup_enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_model_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "model_config_id" TEXT,
    "feature" "AiFeature" NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "est_cost" DECIMAL(12,6),
    "lead_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage_id" TEXT,
    "segment" JSONB,
    "mode" "BroadcastMode" NOT NULL DEFAULT 'template',
    "template" TEXT,
    "ai_instruction" TEXT,
    "model_config_id" TEXT,
    "throttle_seconds" INTEGER NOT NULL DEFAULT 300,
    "respect_ai_block" BOOLEAN NOT NULL DEFAULT true,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_dispatch_at" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastTarget" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "status" "BroadcastTargetStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModelConfig_active_idx" ON "AiModelConfig"("active");

-- CreateIndex
CREATE INDEX "AiUsageLog_tenant_id_created_at_idx" ON "AiUsageLog"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "AiUsageLog_model_config_id_created_at_idx" ON "AiUsageLog"("model_config_id", "created_at");

-- CreateIndex
CREATE INDEX "Broadcast_tenant_id_status_idx" ON "Broadcast"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Broadcast_status_idx" ON "Broadcast"("status");

-- CreateIndex
CREATE INDEX "BroadcastTarget_broadcast_id_status_idx" ON "BroadcastTarget"("broadcast_id", "status");

-- AddForeignKey
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_model_config_id_fkey" FOREIGN KEY ("model_config_id") REFERENCES "AiModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastTarget" ADD CONSTRAINT "BroadcastTarget_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
