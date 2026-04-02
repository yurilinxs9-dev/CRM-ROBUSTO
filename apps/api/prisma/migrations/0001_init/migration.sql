-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'GERENTE', 'OPERADOR', 'VISUALIZADOR');

-- CreateEnum
CREATE TYPE "LeadOrigem" AS ENUM ('WHATSAPP_INCOMING', 'WHATSAPP_OUTGOING', 'MANUAL', 'IMPORT', 'LANDING_PAGE', 'INDICACAO');

-- CreateEnum
CREATE TYPE "LeadTemperatura" AS ENUM ('FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACT');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OPERADOR',
    "avatar_url" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "team_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cor" TEXT NOT NULL DEFAULT '#3498DB',
    "ordem" INTEGER NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "is_won" BOOLEAN NOT NULL DEFAULT false,
    "is_lost" BOOLEAN NOT NULL DEFAULT false,
    "auto_action" JSONB,
    "campos_obrigatorios" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "email" TEXT,
    "empresa" TEXT,
    "cargo" TEXT,
    "origem" "LeadOrigem" NOT NULL DEFAULT 'WHATSAPP_INCOMING',
    "temperatura" "LeadTemperatura" NOT NULL DEFAULT 'FRIO',
    "valor_estimado" DECIMAL(12,2),
    "score" INTEGER NOT NULL DEFAULT 0,
    "tags" JSONB DEFAULT '[]',
    "dados_custom" JSONB DEFAULT '{}',
    "ultima_interacao" TIMESTAMP(3),
    "proximo_followup" TIMESTAMP(3),
    "motivo_perda" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "instancia_whatsapp" TEXT NOT NULL,
    "foto_url" TEXT,
    "mensagens_nao_lidas" INTEGER NOT NULL DEFAULT 0,
    "pipeline_id" TEXT NOT NULL,
    "estagio_id" TEXT NOT NULL,
    "responsavel_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "instance_name" TEXT NOT NULL,
    "whatsapp_message_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "media_url" TEXT,
    "media_mimetype" TEXT,
    "media_duration_seconds" INTEGER,
    "media_filename" TEXT,
    "media_size_bytes" INTEGER,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "is_internal_note" BOOLEAN NOT NULL DEFAULT false,
    "sent_by_user_id" TEXT,
    "quoted_message_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "user_id" TEXT,
    "tipo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "dados_antes" JSONB,
    "dados_depois" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappInstance" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "ultimo_check" TIMESTAMP(3),
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInstance" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,

    CONSTRAINT "UserInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceLog" (
    "id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "evento" TEXT NOT NULL,
    "detalhes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cor" TEXT NOT NULL DEFAULT '#3498DB',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTag" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "conteudo" TEXT NOT NULL,
    "atalho" TEXT,
    "user_id" TEXT,
    "is_global" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "instance" TEXT,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "processing_time_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "conteudo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "lida" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "Stage_pipeline_id_ordem_idx" ON "Stage"("pipeline_id", "ordem");

-- CreateIndex
CREATE INDEX "Lead_responsavel_id_estagio_id_idx" ON "Lead"("responsavel_id", "estagio_id");

-- CreateIndex
CREATE INDEX "Lead_instancia_whatsapp_idx" ON "Lead"("instancia_whatsapp");

-- CreateIndex
CREATE INDEX "Lead_pipeline_id_estagio_id_position_idx" ON "Lead"("pipeline_id", "estagio_id", "position");

-- CreateIndex
CREATE INDEX "Lead_ultima_interacao_idx" ON "Lead"("ultima_interacao");

-- CreateIndex
CREATE INDEX "Lead_score_idx" ON "Lead"("score");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_telefone_pipeline_id_key" ON "Lead"("telefone", "pipeline_id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_whatsapp_message_id_key" ON "Message"("whatsapp_message_id");

-- CreateIndex
CREATE INDEX "Message_lead_id_created_at_idx" ON "Message"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "Message_instance_name_created_at_idx" ON "Message"("instance_name", "created_at");

-- CreateIndex
CREATE INDEX "LeadActivity_lead_id_created_at_idx" ON "LeadActivity"("lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappInstance_nome_key" ON "WhatsappInstance"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "UserInstance_user_id_instance_id_key" ON "UserInstance"("user_id", "instance_id");

-- CreateIndex
CREATE INDEX "InstanceLog_instance_id_created_at_idx" ON "InstanceLog"("instance_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_nome_key" ON "Tag"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "LeadTag_lead_id_tag_id_key" ON "LeadTag"("lead_id", "tag_id");

-- CreateIndex
CREATE INDEX "QuickReply_atalho_idx" ON "QuickReply"("atalho");

-- CreateIndex
CREATE INDEX "WebhookLog_event_created_at_idx" ON "WebhookLog"("event", "created_at");

-- CreateIndex
CREATE INDEX "WebhookLog_processed_idx" ON "WebhookLog"("processed");

-- CreateIndex
CREATE INDEX "Notification_user_id_lida_created_at_idx" ON "Notification"("user_id", "lida", "created_at");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_estagio_id_fkey" FOREIGN KEY ("estagio_id") REFERENCES "Stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_quoted_message_id_fkey" FOREIGN KEY ("quoted_message_id") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInstance" ADD CONSTRAINT "UserInstance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInstance" ADD CONSTRAINT "UserInstance_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceLog" ADD CONSTRAINT "InstanceLog_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

