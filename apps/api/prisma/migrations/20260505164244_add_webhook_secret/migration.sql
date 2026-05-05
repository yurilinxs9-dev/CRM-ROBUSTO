-- AlterTable
ALTER TABLE "WhatsappInstance" ADD COLUMN IF NOT EXISTS "webhook_secret" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappInstance_webhook_secret_key" ON "WhatsappInstance"("webhook_secret");
