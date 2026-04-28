-- DropIndex
DROP INDEX "WhatsappInstance_nome_key";

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappInstance_tenant_id_nome_key" ON "WhatsappInstance"("tenant_id", "nome");
