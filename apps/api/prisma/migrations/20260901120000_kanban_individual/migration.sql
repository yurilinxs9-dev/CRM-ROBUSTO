-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "kanban_individual" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Stage" ADD COLUMN     "user_id" TEXT;

-- CreateIndex
CREATE INDEX "Stage_tenant_id_user_id_idx" ON "Stage"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
